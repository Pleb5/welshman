import {Writable, Readable, writable, derived, get} from "svelte/store"
import {Deferred, fromPairs, TaskQueue, dissoc, identity, uniq, defer, sleep, assoc} from "@welshman/lib"
import {stamp, own, hash} from "@welshman/signer"
import {
  TrustedEvent,
  HashedEvent,
  EventTemplate,
  SignedEvent,
  StampedEvent,
  OwnedEvent,
  isStampedEvent,
  isOwnedEvent,
  isHashedEvent,
  isUnwrappedEvent,
  isSignedEvent,
} from "@welshman/util"
import {MultiPublish, AdapterContext, PublishStatus, PublishEvent} from "@welshman/net"
import {repository, tracker} from "./core.js"
import {pubkey, getSession, getSigner} from "./session.js"

const {Pending, Success, Failure, Timeout, Aborted} = PublishStatus

export type ThunkEvent = EventTemplate | StampedEvent | OwnedEvent | TrustedEvent

export type ThunkRequest = {
  event: ThunkEvent
  relays: string[]
  delay?: number
  timeout?: number
  context?: AdapterContext
}

export type ThunkStatus = {
  message: string
  status: PublishStatus
}

export type ThunkStatusByUrl = Record<string, ThunkStatus>

export type Thunk = {
  event: TrustedEvent
  request: ThunkRequest
  controller: AbortController
  result: Deferred<ThunkStatusByUrl>
  status: Writable<ThunkStatusByUrl>
}

export const prepEvent = (event: ThunkEvent) => {
  if (!isStampedEvent(event as StampedEvent)) {
    event = stamp(event)
  }

  if (!isOwnedEvent(event as OwnedEvent)) {
    event = own(event as StampedEvent, get(pubkey)!)
  }

  if (!isHashedEvent(event as HashedEvent)) {
    event = hash(event as OwnedEvent)
  }

  return event as TrustedEvent
}

export const makeThunk = (request: ThunkRequest) => {
  const event = prepEvent(request.event)
  const controller = new AbortController()
  const result: Thunk["result"] = defer()
  const status: Thunk["status"] = writable({})

  return {event, request, controller, result, status}
}

export type MergedThunk = {
  thunks: Thunk[]
  controller: AbortController
  result: Promise<ThunkStatusByUrl[]>
  status: Readable<ThunkStatusByUrl>
}

export const isMergedThunk = (thunk: Thunk | MergedThunk): thunk is MergedThunk =>
  Boolean((thunk as any).thunks)

export const mergeThunks = (thunks: Thunk[]) => {
  const controller = new AbortController()

  controller.signal.addEventListener("abort", () => {
    for (const thunk of thunks) {
      thunk.controller.abort()
    }
  })

  return {
    thunks,
    controller,
    result: Promise.all(thunks.map(thunk => thunk.result)),
    status: derived(
      thunks.map(thunk => thunk.status),
      statuses => {
        const mergedStatus: ThunkStatusByUrl = {}

        for (const url of uniq(statuses.flatMap(s => Object.keys(s)))) {
          const urlStatuses = statuses.map(s => s[url])
          const thunkStatus = [Aborted, Failure, Timeout, Pending, Success]
            .map(status => urlStatuses.find(s => s?.status === status))
            .find(identity)

          if (thunkStatus) {
            mergedStatus[url] = thunkStatus
          }
        }

        return mergedStatus
      },
    ),
  }
}

export function* walkThunks(thunks: (Thunk | MergedThunk)[]): Iterable<Thunk> {
  for (const thunk of thunks) {
    if (isMergedThunk(thunk)) {
      yield* walkThunks(thunk.thunks)
    } else {
      yield thunk
    }
  }
}

export const thunks = writable<Record<string, Thunk | MergedThunk>>({})

export const publishThunk = (request: ThunkRequest) => {
  const thunk = makeThunk(request)

  thunkQueue.push(thunk)

  repository.publish(thunk.event)

  thunks.update(assoc(thunk.event.id, thunk))

  thunk.controller.signal.addEventListener("abort", () => {
    repository.removeEvent(thunk.event.id)
  })

  return thunk
}

export const publishThunks = (requests: ThunkRequest[]) => {
  const newThunks = requests.map(makeThunk)
  const mergedThunk = mergeThunks(newThunks)

  for (const thunk of newThunks) {
    thunkQueue.push(thunk)

    repository.publish(thunk.event)

    thunks.update(assoc(thunk.event.id, mergedThunk))

    thunk.controller.signal.addEventListener("abort", () => {
      repository.removeEvent(thunk.event.id)
    })
  }

  return mergedThunk
}

export const abortThunk = (thunk: Thunk) => {
  thunk.controller.abort()
  thunks.update(dissoc(thunk.event.id))
  repository.removeEvent(thunk.event.id)
}

export const thunkQueue = new TaskQueue<Thunk>({
  batchSize: 50,
  processItem: (thunk: Thunk) => {
    let event = thunk.event

    // Handle abort immediately if possible
    if (thunk.controller.signal.aborted) return

    // If we were given a wrapped event, make sure to publish the wrapper, not the rumor
    if (isUnwrappedEvent(event)) {
      event = event.wrap
    }

    // Avoid making this function async so multiple publishes can run concurrently
    Promise.resolve().then(async () => {
      const fail = (message: string) => {
        const status: ThunkStatusByUrl = {}

        for (const url of thunk.request.relays) {
          status[url] = {status: PublishStatus.Failure, message}
        }

        thunk.status.set(status)
      }

      // If the event was already signed, leave it alone. Otherwise, sign it now. This is to
      // decrease apparent latency in the UI that results from waiting for remote signers
      if (!isSignedEvent(event)) {
        const signer = getSigner(getSession(event.pubkey))

        if (!signer) {
          return fail(`No signer found for ${event.pubkey}`)
        }

        try {
          event = await signer.sign(event)
        } catch (e: any) {
          return fail(String(e.error || e))
        }
      }

      // We're guaranteed to have a signed event at this point
      const signedEvent = event as SignedEvent

      // Wait if the thunk is to be delayed
      if (thunk.request.delay) {
        await sleep(thunk.request.delay)
      }

      // Skip publishing if aborted
      if (thunk.controller.signal.aborted) {
        return
      }

      // Update status to pending
      thunk.status.set(
        fromPairs(
          thunk.request.relays
            .map(url => [url, {status: PublishStatus.Pending, message: "Sending your message..."}])
        )
      )

      // Send it off
      const pub = new MultiPublish({
        event: signedEvent,
        relays: thunk.request.relays,
        context: thunk.request.context,
        timeout: thunk.request.timeout,
      })

      // Copy the signature over since we had deferred it
      const savedEvent = repository.getEvent(signedEvent.id) as SignedEvent

      // The event may already be replaced or deleted
      if (savedEvent) {
        savedEvent.sig = signedEvent.sig
      }

      pub.on(PublishEvent.Success, (id: string, message: string, url: string) => {
        tracker.track(id, url)
        thunk.status.update(assoc(url, {status: PublishStatus.Success, message}))
      })

      pub.on(PublishEvent.Failure, (id: string, message: string, url: string) => {
        thunk.status.update(assoc(url, {status: PublishStatus.Failure, message}))
      })

      pub.on(PublishEvent.Timeout, (url: string) => {
        thunk.status.update(
          assoc(url, {status: PublishStatus.Timeout, message: "Publish timed out"}),
        )
      })

      pub.on(PublishEvent.Aborted, (url: string) => {
        thunk.status.update(
          assoc(url, {status: PublishStatus.Aborted, message: "Publish was aborted"}),
        )
      })

      pub.on(PublishEvent.Complete, () => {
        thunk.result.resolve(get(thunk.status))
      })
    })
  },
})
