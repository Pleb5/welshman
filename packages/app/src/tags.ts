import {uniq, remove, nthEq} from "@welshman/lib"
import {
  getAddress,
  isReplaceable,
  getReplyTags,
  getPubkeyTagValues,
  isReplaceableKind,
} from "@welshman/util"
import type {TrustedEvent} from "@welshman/util"
import {displayProfileByPubkey} from "./profiles.js"
import {pubkey} from "./session.js"
import {Router} from "./router.js"

export const tagZapSplit = (pubkey: string, split = 1) => [
  "zap",
  pubkey,
  Router.get().FromPubkey(pubkey).getUrl() || "",
  String(split),
]

export const tagPubkey = (pubkey: string, ...args: unknown[]) => [
  "p",
  pubkey,
  Router.get().FromPubkey(pubkey).getUrl() || "",
  displayProfileByPubkey(pubkey),
]

export const tagEvent = (event: TrustedEvent, mark = "") => {
  const url = Router.get().Event(event).getUrl() || ""
  const tags = [["e", event.id, url, mark, event.pubkey]]

  if (isReplaceable(event)) {
    tags.push(["a", getAddress(event), url, mark, event.pubkey])
  }

  return tags
}

export const tagEventPubkeys = (event: TrustedEvent) =>
  uniq(remove(pubkey.get()!, [event.pubkey, ...getPubkeyTagValues(event.tags)])).map(tagPubkey)

export const tagEventForQuote = (event: TrustedEvent) => [
  "q",
  event.id,
  Router.get().Event(event).getUrl() || "",
  event.pubkey,
]

export const tagEventForReply = (event: TrustedEvent) => {
  const tags = tagEventPubkeys(event)

  // Based on NIP 10 legacy tags, order is root, mentions, reply
  const {roots, replies, mentions} = getReplyTags(event.tags)

  // Root comes first
  if (roots.length > 0) {
    for (const t of roots) {
      tags.push([...t.slice(0, 2), Router.get().EventRoots(event).getUrl() || "", "root"])
    }
  } else {
    for (const t of replies) {
      tags.push([...t.slice(0, 2), Router.get().EventParents(event).getUrl() || "", "root"])
    }
  }

  // Inherit mentions
  for (const t of mentions) {
    if (!tags.some(nthEq(1, t[1]))) {
      tags.push([...t.slice(0, 3), "mention"])
    }
  }

  // Inherit replies if they weren't already included
  if (roots.length > 0) {
    for (const t of replies) {
      if (!tags.some(nthEq(1, t[1]))) {
        tags.push([...t.slice(0, 3), "mention"])
      }
    }
  }

  // Finally, tag the event itself
  const mark = replies.length > 0 ? "reply" : "root"
  const hint = Router.get().Event(event).getUrl() || ""

  // e-tag the event
  tags.push(["e", event.id, hint, mark, event.pubkey])

  // a-tag the event
  if (isReplaceable(event)) {
    tags.push(["a", getAddress(event), hint, mark, event.pubkey])
  }

  return tags
}

export const tagEventForComment = (event: TrustedEvent) => {
  const pubkeyHint = Router.get().FromPubkey(event.pubkey).getUrl() || ""
  const eventHint = Router.get().Event(event).getUrl() || ""
  const address = getAddress(event)
  const seenRoots = new Set<string>()
  const tags: string[][] = []

  for (const [t, ...tag] of event.tags) {
    if (["K", "E", "A", "I", "P"].includes(t)) {
      tags.push([t, ...tag])
      seenRoots.add(t)
    }
  }

  if (seenRoots.size === 0) {
    tags.push(["K", String(event.kind)])
    tags.push(["P", event.pubkey, pubkeyHint])
    tags.push(["E", event.id, eventHint, event.pubkey])

    if (isReplaceableKind(event.kind)) {
      tags.push(["A", address, eventHint, event.pubkey])
    }
  }

  tags.push(["k", String(event.kind)])
  tags.push(["p", event.pubkey, pubkeyHint])
  tags.push(["e", event.id, eventHint, event.pubkey])

  if (isReplaceableKind(event.kind)) {
    tags.push(["a", address, eventHint, event.pubkey])
  }

  return tags
}

export const tagEventForReaction = (event: TrustedEvent) => {
  const hint = Router.get().Event(event).getUrl() || ""
  const tags: string[][] = []

  // Mention the event's author
  if (event.pubkey !== pubkey.get()) {
    tags.push(tagPubkey(event.pubkey))
  }

  tags.push(["k", String(event.kind)])
  tags.push(["e", event.id, hint])

  if (isReplaceable(event)) {
    tags.push(["a", getAddress(event), hint])
  }

  return tags
}
