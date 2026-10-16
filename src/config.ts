function flag(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "" || v.startsWith("${")) return def;
  return !/^(0|false|no|off)$/i.test(v.trim());
}

export const config = {
  /** When false, messages_send refuses and mail_compose only opens drafts. */
  get allowSending() {
    return flag("ORCHARD_ALLOW_SEND", true);
  },
};
