import { AppRegistry, LogBox } from 'react-native';
import TrackPlayer from 'react-native-track-player';
import App from './src/App';
import { name as appName } from './app.json';
import { PlaybackService } from './src/PlaybackService';

// Register the headless task that the native MusicService looks up by the key
// "TrackPlayer" (see MusicService.getTaskConfig). Without this the service logs
// "No task registered for key TrackPlayer" on every start and has no defined
// task lifecycle.
//
// The provider MUST return a function: AppRegistryImpl.startHeadlessTask does
// `taskProvider()(data)`, calling the provider with no arguments to obtain the
// real task. Returning the promise from PlaybackService() directly makes RN try
// to call that promise and throws "TypeError: Object is not a function", which
// kills the app.
//
// On Android registerPlaybackService only registers the task — it does not invoke
// the factory. The event listeners are attached from App.tsx via
// PlaybackService(), which is guarded against double registration, so invoking it
// from here as well is safe.
TrackPlayer.registerPlaybackService(() => async () => {
  await PlaybackService();
});

// Persist the last fatal JS error to storage so it can be shown on next launch
// ("Show last crash" on the error screen). This replaces silent death with a
// visible diagnosis when a phone has no adb connection.
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const AsyncStorage = require('@react-native-async-storage/async-storage').default;
  const ORIGINAL = global.ErrorUtils && global.ErrorUtils.getGlobalHandler
    ? global.ErrorUtils.getGlobalHandler()
    : null;
  global.ErrorUtils?.setGlobalHandler?.((error, isFatal) => {
    try {
      const msg = error instanceof Error ? `${error.name}: ${error.message}\n${(error.stack || '').slice(0, 900)}` : String(error);
      void AsyncStorage.setItem('movira:lastCrash', String(msg).slice(0, 1500));
    } catch {
      /* storage unavailable — nothing more we can do */
    }
    // ALWAYS defer to the original handler.
    //
    // This used to call it only for NON-fatal errors, with a comment claiming
    // that kept "the default fatal behaviour (crash screen)". The code did the
    // opposite: a FATAL error was swallowed, so React Native never reported it
    // and the app sat on a blank screen with nothing rendered and no error
    // anywhere — the exact "it does not open on my phone" symptom, with the
    // diagnosis destroyed before it could be read.
    //
    // Render errors that a component can recover from are already handled by
    // CrashGuard; a genuine fatal means the app cannot run, and the correct
    // behaviour is to surface it loudly rather than show a dead screen.
    if (ORIGINAL) ORIGINAL(error, isFatal);
  });
} catch {
  /* handler setup is best-effort */
}

// Silence the LOG box only. This must NOT extend to errors: hiding the red
// error screen is what turns a startup failure into an unopenable app.
LogBox.ignoreAllLogs(true);

AppRegistry.registerComponent(appName, () => App);
