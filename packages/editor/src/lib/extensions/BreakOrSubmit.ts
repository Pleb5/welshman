import {HardBreak, type HardBreakOptions} from "@tiptap/extension-hard-break"

export interface BreakOrSubmitOptions extends HardBreakOptions {
  /** Handler for when enter is pressed. */
  submit: () => void
}

export const BreakOrSubmit = HardBreak.extend<BreakOrSubmitOptions>({
  addKeyboardShortcuts() {
    return {
      "Shift-Enter": () => this.editor.commands.setHardBreak(),
      "Mod-Enter": () => {
        this.options.submit()

        return true
      },
    }
  },
})
