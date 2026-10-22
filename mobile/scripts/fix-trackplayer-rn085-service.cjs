/**
 * Native compatibility fix for react-native-track-player 4.1.2 on RN 0.85.
 *
 * RN 0.85 removed the legacy (bridge) architecture outright:
 * `ReactInstanceManager`'s constructor now unconditionally throws
 *     java.lang.UnsupportedOperationException:
 *     "ReactInstanceManager.createReactContext is unsupported."
 * react-native-track-player 4.1.2 still reaches for that removed API, so every
 * `MusicService` event emit killed the process ~1.1s after launch:
 *
 *   E/AndroidRuntime: FATAL EXCEPTION: main
 *   E/AndroidRuntime: java.lang.UnsupportedOperationException: ReactInstanceManager.createReactContext is unsupported.
 *   E/AndroidRuntime:   at com.doublesymmetry.trackplayer.service.MusicService.emit(MusicService.kt:744)
 *
 * `HeadlessJsTaskService` already exposes an architecture-aware `reactContext`
 * (ReactHost.currentReactContext under bridgeless, ReactInstanceManager under
 * bridge), and `ReactContext.emitDeviceEvent` is the supported way to reach JS.
 * So this rewrites the two emit paths onto that API.
 *
 * Second fix, same file family: ColorOS/OxygenOS denies `startForeground()`
 * with ForegroundServiceStartNotAllowedException even while the activity is being
 * brought up. `MusicService.onStartCommand` called it unguarded, so a denied
 * promotion became a second fatal crash. It is now guarded, and `setupPlayer`
 * degrades to a plain `startService()` when no activity is attached yet (the
 * service is bindService()d either way, and re-foregrounds itself when real
 * playback begins).
 *
 * Idempotent: re-running reports 0 replacements. Fails loudly if the expected
 * upstream source is not found.
 */
const fs = require('fs');
const path = require('path');

const base = path.join(
  __dirname, '..', 'node_modules', 'react-native-track-player',
  'android', 'src', 'main', 'java', 'com', 'doublesymmetry', 'trackplayer'
);
const serviceFile = path.join(base, 'service', 'MusicService.kt');
const moduleFile = path.join(base, 'module', 'MusicModule.kt');

const edits = [
  {
    file: serviceFile,
    label: 'MusicService.emit -> reactContext.emitDeviceEvent',
    from: [
      '    private fun emit(event: String, data: Bundle? = null) {',
      '        reactNativeHost.reactInstanceManager.currentReactContext',
      '            ?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)',
      '            ?.emit(event, data?.let { Arguments.fromBundle(it) })',
      '    }',
    ].join('\n'),
    to: [
      '    private fun emit(event: String, data: Bundle? = null) {',
      '        try {',
      '            reactContext?.emitDeviceEvent(event, data?.let { Arguments.fromBundle(it) })',
      '        } catch (error: Throwable) {',
      '            Timber.e(error, "Movira: could not emit $event to JS")',
      '        }',
      '    }',
    ].join('\n'),
  },
  {
    file: serviceFile,
    label: 'MusicService.emitList -> reactContext.emitDeviceEvent',
    from: [
      '        reactNativeHost.reactInstanceManager.currentReactContext',
      '            ?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)',
      '            ?.emit(event, payload)',
      '    }',
    ].join('\n'),
    to: [
      '        try {',
      '            reactContext?.emitDeviceEvent(event, payload)',
      '        } catch (error: Throwable) {',
      '            Timber.e(error, "Movira: could not emit $event to JS")',
      '        }',
      '    }',
    ].join('\n'),
  },
  {
    file: serviceFile,
    label: 'MusicService.startAndStopEmptyNotificationToAvoidANR guarded',
    from: [
      '        val notification = notificationBuilder.build()',
      '        startForeground(EMPTY_NOTIFICATION_ID, notification)',
      '        @Suppress("DEPRECATION")',
      '        stopForeground(true)',
      '    }',
    ].join('\n'),
    to: [
      '        val notification = notificationBuilder.build()',
      '        try {',
      '            startForeground(EMPTY_NOTIFICATION_ID, notification)',
      '            @Suppress("DEPRECATION")',
      '            stopForeground(true)',
      '        } catch (error: Exception) {',
      '            // Some vendor ROMs refuse startForeground() from onStartCommand even',
      '            // while the activity is coming up. The service is bind()d as well, so',
      '            // it stays alive and foregrounds properly when playback really starts.',
      '            Timber.e(error, "Movira: startForeground denied in the ANR workaround")',
      '        }',
      '    }',
    ].join('\n'),
  },
  {
    file: moduleFile,
    label: 'MusicModule.setupPlayer activity-aware service start',
    from: [
      '        Intent(context, MusicService::class.java).also { intent ->',
      '            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {',
      '                context.startForegroundService(intent)',
      '            } else {',
      '                context.startService(intent)',
      '            }',
      '            context.bindService(intent, this, Context.BIND_AUTO_CREATE)',
      '        }',
    ].join('\n'),
    to: [
      '        Intent(context, MusicService::class.java).also { intent ->',
      '            // A foreground-service start that is never allowed to call',
      '            // startForeground() is what vendor ROMs reject here. Only ask for one',
      '            // once an activity is actually attached; otherwise the service is',
      '            // started plainly and merely bound, which is all the ANR workaround',
      '            // and the initial notification need.',
      '            val activityAttached = try {',
      '                reactApplicationContext.currentActivity?.let { !it.isFinishing } == true',
      '            } catch (error: Throwable) {',
      '                false',
      '            }',
      '            try {',
      '                if (activityAttached && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {',
      '                    context.startForegroundService(intent)',
      '                } else {',
      '                    context.startService(intent)',
      '                }',
      '            } catch (error: Throwable) {',
      '                Timber.e(error, "Movira: could not start MusicService; binding only")',
      '            }',
      '            context.bindService(intent, this, Context.BIND_AUTO_CREATE)',
      '        }',
    ].join('\n'),
  },
];

const byFile = new Map();
for (const edit of edits) {
  if (!byFile.has(edit.file)) byFile.set(edit.file, []);
  byFile.get(edit.file).push(edit);
}

let applied = 0;
for (const [file, fileEdits] of byFile) {
  const raw = fs.readFileSync(file, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  let src = raw.replace(/\r\n/g, '\n');

  for (const edit of fileEdits) {
    if (src.includes(edit.to)) {
      continue; // already applied
    }
    if (!src.includes(edit.from)) {
      console.error(
        `\nFAILED: could not locate upstream source for "${edit.label}".\n` +
        `        react-native-track-player is probably a different version; this\n` +
        `        script must be updated to match.\n        file: ${file}`
      );
      process.exit(1);
    }
    src = src.replace(edit.from, edit.to);
    applied += 1;
  }

  fs.writeFileSync(file, src.replace(/\n/g, eol), 'utf8');
}

console.log(`Movira RN 0.85 track-player fix: applied ${applied} replacement(s)`);
if (applied > 0) console.log('Re-run to confirm idempotency (expect: applied 0).');
console.log('ALL CHECKS PASSED');
