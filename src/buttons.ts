import { randomBytes } from "node:crypto";
export interface Keyboard { inline_keyboard: { text: string; callback_data: string }[][] }
interface Action { group: string; command: string; expires: number; generation?: number; confirm: boolean }

/** Opaque short tokens: model IDs never hit Telegram's 64-byte callback_data limit. */
export class Buttons {
  private actions = new Map<string, Action>();
  constructor(private now = () => Date.now()) {}
  keyboard(rows: { text: string; command: string; generation?: number; confirm?: boolean }[][]): Keyboard {
    for (const [key, value] of this.actions) if (value.expires < this.now()) this.actions.delete(key);
    const group = randomBytes(8).toString("hex");
    return { inline_keyboard: rows.map(row => row.map(button => {
      while (this.actions.size >= 500) this.actions.delete(this.actions.keys().next().value!);
      const key = `p2:${randomBytes(12).toString("hex")}`;
      this.actions.set(key, { group, command: button.command, generation: button.generation, confirm: button.confirm ?? false, expires: this.now() + 15 * 60_000 });
      return { text: button.text, callback_data: key };
    })) };
  }
  take(key: string, generation: number): Action | undefined {
    const action = this.actions.get(key);
    this.actions.delete(key);
    if (action) for (const [id, other] of this.actions) if (other.group === action.group) this.actions.delete(id);
    // Consume the entire keyboard: cancelling also invalidates its confirmation button.
    if (!action || action.expires < this.now() || (action.generation !== undefined && action.generation !== generation)) return;
    return action;
  }
}
