import { useEffect, useRef, useState } from "react";
import {
  createTokenSource, createDriveClient, createBackupScheduler, listForRestore, KEYS,
} from "./lib/driveBackup.js";
import { connectViaPopup, fetchAccountEmail, revokeToken } from "./lib/googleAuth.js";

// Wires lib/driveBackup.js's pure pieces to the browser: the real fetch,
// timers, the settings store, and the moments an owed backup should be picked
// up. Those are app start, coming back online, and the app being made visible
// again. Created once per app (in App), so there
// is exactly one scheduler and one timer whatever the UI is doing.
export function useDriveBackup(app) {
  const ref = useRef(null);
  const [status, setStatus] = useState(null);

  if (!ref.current) {
    const settings = {
      get: (k, fb) => app.store.getSetting(k, fb),
      set: (k, v) => app.store.setSetting(k, v),
    };
    const loadRefreshToken = () => settings.get(KEYS.REFRESH_TOKEN, null);
    const tokens = createTokenSource({ fetch: window.fetch.bind(window), now: Date.now, loadRefreshToken });
    const drive = createDriveClient({ fetch: window.fetch.bind(window), getAccessToken: tokens.getAccessToken });
    const scheduler = createBackupScheduler({
      settings,
      drive,
      exportBundle: () => app.store.exportAll(),
      isConnected: async () => !!(await loadRefreshToken()),
      now: Date.now,
      setTimeout: (f, ms) => window.setTimeout(f, ms),
      clearTimeout: (t) => window.clearTimeout(t),
      isOnline: () => navigator.onLine !== false,
      onStatus: (s) => ref.current?.setStatus?.(s),
    });
    app.setBackupListener(() => scheduler.noteChange());
    ref.current = { settings, tokens, drive, scheduler, setStatus: null };
  }
  ref.current.setStatus = setStatus;

  useEffect(() => {
    const { scheduler } = ref.current;
    const poke = () => scheduler.poke();
    const onVisible = () => { if (document.visibilityState === "visible") poke(); };
    window.addEventListener("online", poke);
    document.addEventListener("visibilitychange", onVisible);
    poke(); // app start: picks up a backup owed from before a kill or reboot
    // Status depends on the clock as well as on events: a change can become
    // a day overdue while the app sits open. A minute is plenty for a dot
    // that only cares about a 24 h threshold.
    const t = window.setInterval(poke, 60_000);
    return () => {
      window.removeEventListener("online", poke);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(t);
      scheduler.cancel();
    };
  }, []);

  const { settings, tokens, drive, scheduler } = ref.current;

  return {
    status,

    /** Call straight from the tap: the popup must open inside the gesture. */
    async connect({ signal } = {}) {
      const { refreshToken, accessToken } = await connectViaPopup({ signal });
      await settings.set(KEYS.REFRESH_TOKEN, refreshToken);
      tokens.forget(); // any cached access token belonged to the old grant
      await settings.set(KEYS.ACCOUNT, await fetchAccountEmail({ fetch: window.fetch.bind(window), accessToken }));
      return scheduler.connected();
    },

    async disconnect() {
      const token = await settings.get(KEYS.REFRESH_TOKEN, null);
      // Revoking the refresh token also revokes every access token issued
      // from it.
      if (token) await revokeToken({ fetch: window.fetch.bind(window), token });
      await settings.set(KEYS.REFRESH_TOKEN, null);
      await settings.set(KEYS.ACCOUNT, null);
      tokens.forget();
      await scheduler.disconnected();
    },

    backupNow: () => scheduler.backupNow(),
    listBackups: async () => listForRestore(await drive.list()),
    downloadBackup: (id) => drive.download(id),
    refreshStatus: () => scheduler.poke(),
  };
}
