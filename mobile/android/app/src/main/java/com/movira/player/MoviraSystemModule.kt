package com.movira.player

import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.graphics.RenderEffect
import android.graphics.Shader
import android.hardware.Sensor
import android.media.MediaCodecList
import android.media.MediaExtractor
import android.media.MediaFormat
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.media.AudioManager
import android.net.Uri
import android.provider.OpenableColumns
import android.provider.MediaStore
import android.view.View
import android.view.WindowManager
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * Bridge for the device-level controls React Native does not expose: media
 * volume, window brightness, orientation locking, real fullscreen, picture in
 * picture, opening links in the browser, and the `content://` plumbing behind
 * "Open with" file opens from other apps.
 *
 * Volume and brightness are only meaningful for the activity window, so the
 * activity is fetched per call rather than cached — the player can be opened
 * before the activity reference is available.
 *
 * The module also registers itself as an [ActivityEventListener] to receive
 * `onNewIntent`. React Native's own Linking module cannot be used for this: as of
 * 0.85 `IntentModule` implements only `getInitialURL` and no longer listens for
 * new intents, so its `url` event never fires for an ACTION_VIEW delivered to an
 * already-running activity — which is exactly the case "Open with" produces once
 * Movira is in the background.
 */
class MoviraSystemModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), ActivityEventListener {

  companion object {
    /** Device event carrying a media file handed over by another app. */
    const val EVENT_OPEN_MEDIA = "moviraOpenMedia"

    /** MediaStore's filesystem-path column, spelled out to avoid the deprecation. */
    private const val COLUMN_DATA = "_data"

    /**
     * `/sdcard` is a symlink onto the primary volume. A file manager hands out
     * paths through it while the library scanner records the real mount, so both
     * spellings have to be understood for one file to be recognised as one.
     */
    private const val SDCARD_ROOT = "/sdcard"
    private const val STORAGE_ROOT = "/storage/emulated/0"

    /**
     * Upper bound on the blur radius. Anything beyond a couple of dozen pixels is
     * invisible through a dark veil but keeps costing a GPU pass on every frame.
     */
    private const val MAX_BLUR_RADIUS = 25.0

    /**
     * Device event carrying the PHYSICAL orientation of the handset.
     *
     * Values are the two the player cares about: "portrait" (upright or upside
     * down) and "landscape" (either side).
     */
    const val EVENT_DEVICE_ORIENTATION = "moviraDeviceOrientation"

    /**
 * Directions, in the device frame, at which gravity falls on a single axis.
 *
 * 90 is upright portrait, 0 and 180 are the two side-on (landscape) positions
 * 180 degrees apart, and 270 is upside-down portrait. A reading is compared to
 * these rather than to one axis at a time, because the two landscape positions
 * are exactly the ones where the vertical axis reads zero.
 */
private val SKY_DIRECTION_TARGETS = doubleArrayOf(0.0, 90.0, 180.0, 270.0)

    /**
     * Below this, in-plane gravity, the phone is flat on its back: nothing lands
     * in the screen plane and there is no orientation to report.
     *
     * This is a LENGTH, not an axis threshold. Testing one axis alone also
     * rejected a phone held exactly side-on, which is where both landscape
     * positions actually are.
     */
    private const val ORIENTATION_FLAT_EPSILON = 3.5

    /**
     * How close, in degrees, the reading must be to a side-on direction before
     * that orientation is adopted.
     *
     * 20 degrees keeps the switch prompt — it fires within 20 degrees of the true
     * transition — while giving a 40 degree dead band between orientations so a
     * phone held near a boundary does not flicker. A tighter band chatters; a
     * wider one is what made the opposite landscape feel like it needed extra
     * rotation.
     */
    private const val ORIENTATION_DEAD_BAND_DEGREES = 20.0

    /**
     * The live module instance.
     *
     * Held so the system delete result can be delivered without going back through
     * the React context, which is typically unreachable by the time it arrives.
     */
    @Volatile private var live: MoviraSystemModule? = null

    /**
     * Settles the pending system delete prompt.
     *
     * Reached statically from MainActivity's launcher rather than through the React
     * context: when the system delete activity closes, the context is often no
     * longer reachable, so a context lookup returned null and the promise was never
     * settled. The module instance itself is still alive — only the task had gone to
     * the background — so a direct reference survives the trip.
     */
    @JvmStatic
    fun deliverDeleteMediaResult(approved: Boolean) {
      val module = live ?: return
      val promise = module.pendingDelete ?: return
      module.pendingDelete = null
      try {
        promise.resolve(approved)
      } catch (e: Exception) {
        // Already settled or the context is gone; nothing left to report to.
      }
    }
  }

  override fun getName(): String = "MoviraSystem"

  init {
    live = this
    reactApplicationContext.addActivityEventListener(this)
  }

  /**
   * An intent that arrived while the activity was already running.
   *
   * It is buffered as well as emitted because the JS listener only exists once
   * the React context is up: an intent delivered in the first moments after a
   * cold start would otherwise be emitted into nothing and lost. `consumeLaunchMedia`
   * drains this buffer, and JavaScript ignores a URI it has already handled, so
   * the overlap is harmless.
   */
  private var pendingNewIntent: Intent? = null

  /**
   * The in-flight system delete prompt, if one is showing.
   *
   * `MediaStore.createDeleteRequest` hands back a PendingIntent that shows the
   * platform's own "Allow Movira to delete this?" dialog. It is the only route to
   * deleting media on Android 11+ WITHOUT "All files access", so it is what makes
   * Delete work for an ordinary user — but the outcome only arrives back here, in
   * [onActivityResult], and the JavaScript promise has to be held until then.
   */
  private var pendingDelete: Promise? = null

  override fun onActivityResult(
      activity: android.app.Activity,
      requestCode: Int,
      resultCode: Int,
      data: Intent?
  ) = Unit

  /**
   * Deletes media through the platform's own confirmation dialog.
   *
   * `java.io.File.delete()` — which is what `unlink()` ends up calling — cannot
   * remove a file the app does not own, and reports that as a plain `false` that
   * the library silently discards. The user then taps Delete, nothing happens,
   * and the item is still there after the next scan. That is the reported bug.
   *
   * Android's answer to that is `createDeleteRequest`, which puts the decision in
   * the user's hands: one system prompt, no blanket permission needed, and the
   * file really is removed afterwards. Paths are matched against MediaStore rows
   * first, so anything the store does not know about resolves false and the
   * caller can fall back to saying so plainly.
   */
  @ReactMethod
  fun requestDeleteMedia(paths: ReadableArray, promise: Promise) {
    try {
      val activity = reactApplicationContext.currentActivity as? MainActivity
      if (activity == null) {
        promise.resolve(false)
        return
      }
      if (android.os.Build.VERSION.SDK_INT < 30) {
        // Pre-scoped-storage: the plain unlink() path is unrestricted there.
        promise.resolve(false)
        return
      }
      val resolver = reactApplicationContext.contentResolver
      val uris = ArrayList<Uri>()
      for (i in 0 until paths.size()) {
        val path = paths.getString(i) ?: continue
        mediaStoreUriForPath(resolver, path)?.let { uris.add(it) }
      }
      if (uris.isEmpty()) {
        promise.resolve(false)
        return
      }
      // One prompt per delete, not one per file.
      val request = MediaStore.createDeleteRequest(resolver, uris)
      // A second tap while the first prompt is still up would orphan a promise.
      if (pendingDelete != null) {
        promise.resolve(false)
        return
      }
      pendingDelete = promise
      if (!activity.launchMediaDelete(request)) {
        pendingDelete = null
        promise.resolve(false)
      }
    } catch (e: Exception) {
      pendingDelete = null
      promise.resolve(false)
    }
  }

  /** The MediaStore row for a filesystem path, in whichever collection holds it. */
  private fun mediaStoreUriForPath(resolver: android.content.ContentResolver, path: String): Uri? {
    val projection = arrayOf(MediaStore.MediaColumns._ID)
    val selection = "${MediaStore.MediaColumns.DATA}=?"
    for (table in arrayOf(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, MediaStore.Audio.Media.EXTERNAL_CONTENT_URI)) {
      try {
        resolver.query(table, projection, selection, arrayOf(path), null)?.use { cursor ->
          if (cursor.moveToFirst()) {
            val id = cursor.getLong(0)
            return Uri.withAppendedPath(table, id.toString())
          }
        }
      } catch (e: Exception) {
        // Try the other collection.
      }
    }
    return null
  }

  override fun onNewIntent(intent: Intent) {
    val payload = describeMediaIntent(intent) ?: return
    pendingNewIntent = intent
    emitOpenMedia(payload)
  }

  private fun emitOpenMedia(payload: WritableMap) {
    try {
      reactApplicationContext
          .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit(EVENT_OPEN_MEDIA, payload)
    } catch (e: Exception) {
      // No live React context yet. The intent stays buffered in
      // `pendingNewIntent` and is picked up by `consumeLaunchMedia`.
      android.util.Log.w("MoviraJS", "open-media event dropped, no React context", e)
    }
  }

  private val audioManager: AudioManager
    get() = reactApplicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  private val maxVolume: Int
    get() = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)

  private fun clamp01(v: Double): Float = v.coerceIn(0.0, 1.0).toFloat()

  // --- media volume -------------------------------------------------------

  @ReactMethod
  fun getVolume(promise: Promise) {
    try {
      val current = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC)
      promise.resolve(current.toDouble() / maxVolume)
    } catch (e: Exception) {
      promise.reject("E_VOLUME", e)
    }
  }

  @ReactMethod
  fun setVolume(value: Double, promise: Promise) {
    try {
      val level = (clamp01(value) * maxVolume).toInt()
      audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, level, 0)
      promise.resolve(level.toDouble() / maxVolume)
    } catch (e: Exception) {
      promise.reject("E_VOLUME_SET", e)
    }
  }

  /** 0 when the phone is on silent/vibrate, which the UI shows as muted. */
  @ReactMethod
  fun isMuted(promise: Promise) {
    try {
      promise.resolve(audioManager.getStreamVolume(AudioManager.STREAM_MUSIC) == 0)
    } catch (e: Exception) {
      promise.reject("E_MUTE", e)
    }
  }

  // --- window brightness --------------------------------------------------

  /**
   * Screen brightness lives on the activity window rather than in Settings, so
   * the change is scoped to Movira and is not restored automatically when the
   * app is left — the module resets it on host destroy to avoid leaving the
   * phone dim.
   */
  @ReactMethod
  fun getBrightness(promise: Promise) {
    try {
      val activity = reactApplicationContext.currentActivity
      if (activity == null) {
        promise.resolve(null)
        return
      }
      val attr = activity.window.attributes
      // -1 means "follow the system setting"; report 1 so the UI shows full.
      val v = if (attr.screenBrightness < 0f) 1f else attr.screenBrightness
      promise.resolve(v.toDouble())
    } catch (e: Exception) {
      promise.reject("E_BRIGHTNESS", e)
    }
  }

  @ReactMethod
  fun setBrightness(value: Double, promise: Promise) {
    try {
      val activity = reactApplicationContext.currentActivity
      if (activity == null) {
        promise.reject("E_BRIGHTNESS_SET", "no activity")
        return
      }
      // Window attributes belong to the UI thread, and a React Native @ReactMethod
      // runs on the native-modules thread. Setting screenBrightness off-thread
      // intermittently threw mid-gesture, which surfaced as "Brightness is not
      // available on this device" — the swipe worked sometimes and failed
      // others. Hopping to the UI thread is the fix.
      activity.runOnUiThread {
        try {
          val attr = activity.window.attributes
          attr.screenBrightness = clamp01(value)
          activity.window.attributes = attr
          promise.resolve(attr.screenBrightness.toDouble())
        } catch (e: Exception) {
          promise.reject("E_BRIGHTNESS_SET", e)
        }
      }
    } catch (e: Exception) {
      promise.reject("E_BRIGHTNESS_SET", e)
    }
  }

  // --- view blur -----------------------------------------------------------

  /**
   * Applies a real Gaussian blur to ONE view, addressed by its React tag.
   *
   * The audio player's volume readout pushes the page behind it out of focus, and
   * a dim veil alone reads as "a dark panel over the screen" rather than as depth.
   * Blurring the actual player content is what makes the overlay the clear focal
   * point, so this targets the exact subtree that sits behind it and nothing
   * else — the layout, the buttons and the artwork are never re-laid out, only
   * filtered, and the filter is removed again when the gesture ends.
   *
   * `RenderEffect` is API 31+, and the app supports API 24, so this resolves to
   * false on older devices and the caller falls back to the veil alone. It also
   * resolves false rather than rejecting for a tag it cannot resolve, so an
   * unresolvable view can never break the gesture.
   *
   * Resolving a view and mutating the view hierarchy both have to happen on the UI
   * thread — same reasoning as `setBrightness` above.
   */
  @ReactMethod
  fun setViewBlur(tag: Double, radius: Double, promise: Promise) {
    if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.S) {
      promise.resolve(false)
      return
    }
    val activity = reactApplicationContext.currentActivity
    if (activity == null) {
      promise.resolve(false)
      return
    }
    activity.runOnUiThread {
      try {
        val ctx = reactApplicationContext
        val view = com.facebook.react.uimanager.UIManagerHelper
            .getUIManagerForReactTag(ctx, tag.toInt())
            ?.let { it.resolveView(tag.toInt()) } as? View
        if (view == null) {
          promise.resolve(false)
          return@runOnUiThread
        }
        val r = radius.coerceIn(0.0, MAX_BLUR_RADIUS).toFloat()
        view.setRenderEffect(
            if (r <= 0.01f) {
              null
            } else {
              RenderEffect.createBlurEffect(r, r, Shader.TileMode.CLAMP)
            })
        promise.resolve(true)
      } catch (e: Exception) {
        promise.resolve(false)
      }
    }
  }

  /** Called when the module is torn down so the phone is not left dimmed. */
  @ReactMethod
  fun resetBrightness(promise: Promise) {
    try {
      val activity = reactApplicationContext.currentActivity ?: run {
        promise.resolve(null)
        return
      }
      // Same UI-thread hop as setBrightness.
      activity.runOnUiThread {
        try {
          val attr = activity.window.attributes
          attr.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
          activity.window.attributes = attr
          promise.resolve(null)
        } catch (e: Exception) {
          promise.reject("E_BRIGHTNESS_RESET", e)
        }
      }
    } catch (e: Exception) {
      promise.reject("E_BRIGHTNESS_RESET", e)
    }
  }

  // --- orientation --------------------------------------------------------

  /**
   * The player drives orientation itself now that it knows each video's real
   * shape, so this takes an explicit mode rather than a boolean:
   *
   *   "auto"      follow the sensor (used when the user hands control back)
   *   "portrait"  lock to portrait
   *   "landscape" lock to landscape
   *
   * Locking rather than recreating the activity matters: MainActivity declares
   * orientation in `configChanges`, so ExoPlayer keeps its buffer and playback
   * continues instead of restarting.
   */
  @ReactMethod
  fun setOrientation(mode: String, promise: Promise) {
    try {
      val activity = reactApplicationContext.currentActivity
      if (activity == null) {
        promise.reject("E_ORIENTATION", "no activity")
        return
      }
      activity.requestedOrientation = when (mode) {
        "portrait" -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        "landscape" -> ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        // The opposite landscape. LANDSCAPE and REVERSE_LANDSCAPE are 180 degrees
        // apart, which is what lets the player follow the handset from one side
        // to the other instead of asking for the same landscape twice.
        "reverseLandscape" -> ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE
        else -> ActivityInfo.SCREEN_ORIENTATION_FULL_USER
      }
      promise.resolve(mode)
    } catch (e: Exception) {
      promise.reject("E_ORIENTATION", e)
    }
  }

  /**
   * Hides the status and navigation bars for real fullscreen. React Native can
   * only hide the status bar, so the navigation bar needs the platform API.
   */
  @ReactMethod
  fun setImmersive(enabled: Boolean, promise: Promise) {
    try {
      val activity = reactApplicationContext.currentActivity ?: run {
        promise.reject("E_IMMERSIVE", "no activity")
        return
      }
      val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
      controller.systemBarsBehavior =
          WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      if (enabled) {
        controller.hide(WindowInsetsCompat.Type.systemBars())
      } else {
        controller.show(WindowInsetsCompat.Type.systemBars())
      }
      promise.resolve(enabled)
    } catch (e: Exception) {
      promise.reject("E_IMMERSIVE", e)
    }
  }

  /**
   * Keeps the display awake during playback. This is the player's single
   * screen on/off control — the same toggle VLC calls "screen on".
   */
  @ReactMethod
  fun setKeepScreenOn(enabled: Boolean, promise: Promise) {
    try {
      val activity = reactApplicationContext.currentActivity
      if (activity == null) {
        promise.reject("E_KEEP_AWAKE", "no activity")
        return
      }
      if (enabled) {
        activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      } else {
        activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      }
      promise.resolve(enabled)
    } catch (e: Exception) {
      promise.reject("E_KEEP_AWAKE", e)
    }
  }

  /**
   * Auto-rotate on lets the sensor drive the player; off locks the activity to
   * whatever orientation it is in right now, so a physical turn does nothing.
   */
  @ReactMethod
  fun setAutoRotate(enabled: Boolean, promise: Promise) {
    try {
      val activity = reactApplicationContext.currentActivity
      if (activity == null) {
        promise.reject("E_ORIENTATION", "no activity")
        return
      }
      activity.requestedOrientation =
          if (enabled) {
            ActivityInfo.SCREEN_ORIENTATION_FULL_USER
          } else {
            ActivityInfo.SCREEN_ORIENTATION_LOCKED
          }
      promise.resolve(enabled)
    } catch (e: Exception) {
      promise.reject("E_ORIENTATION", e)
    }
  }

  @ReactMethod
  fun getAutoRotate(promise: Promise) {
    try {
      val activity = reactApplicationContext.currentActivity
      if (activity == null) {
        promise.reject("E_ORIENTATION_GET", "no activity")
        return
      }
      val locked = activity.requestedOrientation == ActivityInfo.SCREEN_ORIENTATION_LOCKED ||
          activity.requestedOrientation == ActivityInfo.SCREEN_ORIENTATION_PORTRAIT ||
          activity.requestedOrientation == ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
      promise.resolve(!locked)
    } catch (e: Exception) {
      promise.reject("E_ORIENTATION_GET", e)
    }
  }

  /**
   * Returns the real system status-bar height in pixels (from the Android
   * resource `android.R.integer.status_bar_height`). React Native's
   * `StatusBar.currentHeight` can report 0 on some configurations, which
   * leaves the app header drawn under the status bar — this is the
   * reliable source for the inset every screen uses.
   */
  @ReactMethod
  fun getStatusBarHeight(promise: Promise) {
    try {
      val id = reactApplicationContext.resources.getIdentifier(
          "status_bar_height", "dimen", "android")
      val height = if (id != 0) reactApplicationContext.resources.getDimensionPixelSize(id) else 0
      promise.resolve(height.toDouble())
    } catch (e: Exception) {
      promise.reject("E_STATUS_BAR_HEIGHT", e)
    }
  }

  /**
   * Resolves a `content://` URI through the ContentResolver.
   *
   * Everything is best-effort and independently guarded: providers routinely
   * refuse some of these columns while still serving the file, so a failure on
   * one lookup must never discard the others. Returns what could be read, which
   * may legitimately be an empty result — the URI alone is still playable.
   *
   * `path` is the real filesystem location behind the URI where the provider
   * exposes one. That is what lets Movira recognise a file it has already
   * indexed: a `content://` URI and a library entry can never be compared
   * directly, and guessing from the name and size goes wrong whenever a library
   * scan has not finished yet. The literal `_data` column is used instead of the
   * deprecated `MediaStore.MediaColumns.DATA` constant; MediaStore still fills it.
   */
  private fun describeContentUri(parsed: Uri): WritableMap {
    val direct =
        try {
          readMediaColumns(parsed)
        } catch (e: Exception) {
          // Some providers refuse the query; the URI itself still works.
          null
        }
    // Nothing came back from the provider itself.
    //
    // The document picker does not hand out a MediaStore URI, it hands out its
    // OWN URI wrapping the row id:
    //
    //   content://com.android.providers.media.documents/document/video%3A1000067169
    //
    // and MediaDocumentsProvider refuses every column on it — name, size and
    // `_data` all come back null, and so does getType(). That is deliberate: the
    // provider exists to hide the file's location from the caller.
    //
    // Measured on the device, which is how this was found: resolving one of
    // these returned nothing but nulls. Left alone the file still plays, but it
    // can never be recognised as one already in the library, so picking a file
    // the library has also scanned lists that file twice. The row id is right
    // there in the URI, and MediaStore will answer for it, so ask MediaStore.
    val viaRow =
        if (direct?.path == null || direct?.size == null) {
          val row = mediaStoreUriBehind(parsed)
          if (row != null) {
            try {
              readMediaColumns(row)
            } catch (e: Exception) {
              // The row may be gone, or the volume unmounted. Nothing to add.
              null
            }
          } else {
            null
          }
        } else {
          null
        }
    var name = direct?.name ?: viaRow?.name
    var mime = direct?.mime ?: viaRow?.mime
    var size = direct?.size ?: viaRow?.size
    var path = direct?.path ?: viaRow?.path
    try {
      mime = reactApplicationContext.contentResolver.getType(parsed) ?: mime
    } catch (e: Exception) {
      // getType() is best-effort — extension/hint classification still applies.
    }
    val out = Arguments.createMap()
    out.putString("name", name)
    out.putString("mimeType", mime)
    if (size != null) out.putDouble("size", size) else out.putNull("size")
    if (path != null) out.putString("path", path) else out.putNull("path")
    return out
  }

  /** What a provider was willing to say about one URI. Any part may be absent. */
  private class MediaColumns(
      val name: String?,
      val mime: String?,
      val size: Double?,
      val path: String?
  )

  /**
   * Reads display name, MIME, byte size and `_data` from one URI.
   *
   * Reports each independently, so a provider that serves a size but hides the
   * location still contributes what it does have.
   */
  private fun readMediaColumns(target: Uri): MediaColumns? {
    reactApplicationContext.contentResolver
        .query(
            target,
            arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE, COLUMN_DATA),
            null,
            null,
            null)
        ?.use { cursor ->
          if (cursor.moveToFirst()) {
            val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            val name = if (nameIdx >= 0 && !cursor.isNull(nameIdx)) cursor.getString(nameIdx) else null
            val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
            val size = if (sizeIdx >= 0 && !cursor.isNull(sizeIdx)) cursor.getLong(sizeIdx).toDouble() else null
            val pathIdx = cursor.getColumnIndex(COLUMN_DATA)
            val path = if (pathIdx >= 0 && !cursor.isNull(pathIdx)) cursor.getString(pathIdx) else null
            var mime: String? = null
            try {
              mime = reactApplicationContext.contentResolver.getType(target)
            } catch (e: Exception) {
              // Best-effort.
            }
            return MediaColumns(name, mime, size, path)
          }
        }
    return null
  }

  /**
   * The MediaStore row a provider URI is wrapping, or null when it is not one.
   *
   * Recognises the document picker's shape — its final segment is a percent-encoded
   * `<table>:<rowId>` pair such as `video%3A1000067169` — and rebuilds the direct
   * MediaStore URI for that row.
   *
   * Only video and audio are mapped. Movira never opens images, and the images
   * collection has been deprecated, so reaching for it would add a failure mode
   * rather than remove one.
   */
  private fun mediaStoreUriBehind(parsed: Uri): Uri? {
    val segment = parsed.lastPathSegment ?: return null
    val decoded = Uri.decode(segment)
    val separator = decoded.indexOf(':')
    if (separator <= 0) return null
    val collection =
        when (decoded.substring(0, separator).trim()) {
          "video", "video_files" -> "video"
          "audio", "audio_files" -> "audio"
          else -> return null
        }
    val rowId = decoded.substring(separator + 1).trim().toLongOrNull() ?: return null
    val row = Uri.parse("content://media/external/$collection/media/$rowId")
    // Never point back at the URI we were handed: a row URI has no ":" in its
    // last segment and so cannot match here, but this keeps the fallback from
    // ever re-querying its own input if that ever changes.
    return if (row == parsed) null else row
  }

  /**
   * Resolves the display name and MIME type behind a `content://` URI.
   *
   * The document picker hands JavaScript nothing but the URI, and its last
   * segment is often a bare MediaStore id (`.../audio/media/42`) with no file
   * extension — so extension-based classification alone drops the pick on the
   * floor. The ContentResolver is the source of truth for both the label the
   * user sees and the panel the item belongs in.
   */
  @ReactMethod
  fun resolveContentUri(uri: String, promise: Promise) {
    try {
      val parsed = Uri.parse(uri)
      promise.resolve(
          when {
            parsed.scheme == "content" -> describeContentUri(parsed)
            // A file:// URI needs no provider at all to say where it is — it is
            // already the location. Answering null here meant a file picked
            // through a plain file manager could never be matched against the
            // same file in the library.
            parsed.scheme == "file" -> filesystemPathOf(parsed)
            else -> Arguments.createMap().apply {
              putString("name", null)
              putString("mimeType", null)
              putNull("size")
            }
          })
    } catch (e: Exception) {
      promise.reject("E_CONTENT_URI", e)
    }
  }

  /**
   * A `file://` URI as the library records paths.
   *
   * Percent-escapes are decoded and the `/sdcard` alias is expanded, because the
   * library holds the canonical `/storage/emulated/0/...` form and the two have
   * to compare equal for a picked file to be recognised as one it already has.
   */
  private fun filesystemPathOf(parsed: Uri): WritableMap {
    val decoded = Uri.decode(parsed.path ?: "").ifEmpty { null }
    val canonical =
        when {
          decoded == null -> null
          decoded == SDCARD_ROOT -> STORAGE_ROOT
          decoded.startsWith("$SDCARD_ROOT/") -> STORAGE_ROOT + decoded.removePrefix(SDCARD_ROOT)
          else -> decoded
        }
    return Arguments.createMap().apply {
      putString("name", parsed.lastPathSegment?.let { Uri.decode(it) })
      putString("mimeType", null)
      putNull("size")
      if (canonical != null) putString("path", canonical) else putNull("path")
    }
  }

  /**
   * Reads the media file an intent is asking to open, or null when it is not a
   * file-open intent at all.
   *
   * ACTION_EDIT is accepted alongside ACTION_VIEW because some senders use it to
   * mean "open this document for me"; anything else is not a file open. The
   * result is the same shape as `consumeLaunchMedia` returns, so both delivery
   * paths hand JavaScript an identical payload.
   */
  private fun describeMediaIntent(intent: Intent?): WritableMap? {
    if (intent == null) return null
    val action = intent.action ?: return null
    if (action != Intent.ACTION_VIEW && action != Intent.ACTION_EDIT) return null
    val uri = intent.data ?: return null
    val described = describeContentUri(uri)
    val out = Arguments.createMap()
    out.putString("uri", uri.toString())
    out.putString("name", described.getString("name"))
    // The provider's type wins; the sender's declared type is the fallback for
    // providers that do not answer getType().
    out.putString("mimeType", described.getString("mimeType") ?: intent.type)
    if (described.hasKey("size") && !described.isNull("size")) {
      out.putDouble("size", described.getDouble("size"))
    } else {
      out.putNull("size")
    }
    out.putString("path", described.getString("path"))
    return out
  }

  /**
   * Reads and then CONSUMES the media file behind the intent that started the
   * activity, if there is one.
   *
   * Called once from JavaScript during startup, which covers the cold-start case:
   * the user tapped a file in a file manager and Movira was launched purely to
   * play it.
   *
   * A buffered `onNewIntent` wins over the launch intent, because it is the
   * newer request.
   *
   * The launch intent is then cleared, replacing it with a plain ACTION_MAIN.
   * Without that, any later re-read of it — a JS reload, a React remount, the
   * activity being recreated by a configuration change — reopens the same file
   * again, so the player would jump back to it with no user action. Consuming it
   * makes the hand-off exactly once.
   *
   * Resolves null when the activity was started normally from the launcher.
   */
  @ReactMethod
  fun consumeLaunchMedia(promise: Promise) {
    try {
      val activity = reactApplicationContext.currentActivity
      val buffered = pendingNewIntent
      pendingNewIntent = null
      val launch = describeMediaIntent(buffered)
      if (launch != null) {
        promise.resolve(launch)
        return
      }
      if (activity == null) {
        promise.resolve(null)
        return
      }
      val intent = activity.intent
      val payload = describeMediaIntent(intent)
      if (payload != null) {
        activity.intent = Intent(Intent.ACTION_MAIN).setPackage(activity.packageName)
      }
      promise.resolve(payload)
    } catch (e: Exception) {
      promise.reject("E_LAUNCH_MEDIA", e)
    }
  }

  /**
   * Holds on to read access for a `content://` file across restarts.
   *
   * The grant that comes with an ACTION_VIEW intent only lasts as long as the
   * activity's task. Movira keeps opened files so they stay playable later, and
   * without a persisted grant those entries would fail to open after a restart.
   *
   * Only ACTION_OPEN_DOCUMENT grants are persistable, so this legitimately
   * fails for many senders; it resolves false rather than rejecting and the file
   * still plays for the current session.
   */
  @ReactMethod
  fun takePersistableMediaAccess(uri: String, promise: Promise) {
    try {
      val parsed = Uri.parse(uri)
      if (parsed.scheme != "content") {
        promise.resolve(false)
        return
      }
      try {
        reactApplicationContext.contentResolver
            .takePersistableUriPermission(parsed, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        promise.resolve(true)
      } catch (e: SecurityException) {
        // Not a persistable grant — expected for ACTION_VIEW, not an error.
        promise.resolve(false)
      } catch (e: Exception) {
        promise.resolve(false)
      }
    } catch (e: Exception) {
      promise.resolve(false)
    }
  }

  /**
   * Best-effort delete behind a `content://` URI. Files added through the
   * document picker are not filesystem paths, so `unlink()` can never remove
   * them — the ContentResolver is the only way. Resolves true only when the
   * provider actually deleted a row; every refusal resolves false instead of
   * rejecting, because the caller treats it as "remove it from the app".
   */
  @ReactMethod
  fun deleteContentUri(uri: String, promise: Promise) {
    try {
      val parsed = Uri.parse(uri)
      val rows = if (parsed.scheme == "content") {
        reactApplicationContext.contentResolver.delete(parsed, null, null)
      } else {
        0
      }
      promise.resolve(rows > 0)
    } catch (e: Exception) {
      promise.resolve(false)
    }
  }

  /**
   * Opens a web URL in the device's default browser, never in a dedicated app.
   *
   * `Linking.openURL` fires a plain ACTION_VIEW, which Android hands to whichever
   * app claims that host. For `github.com/Rkshah123` that is the official GitHub
   * app, so the link silently left Movira for a different experience than the
   * LinkedIn and website links, which have no installed app and therefore fell
   * through to the browser.
   *
   * The fix is to resolve the browser explicitly and pin the intent to it. The
   * probe below deliberately asks about a neutral host (`example.com`) rather
   * than the URL being opened: an app that claims ONE specific domain (GitHub,
   * X, a news reader) still matches the real URL but does not match the probe,
   * so the probe returns the actual browser and only that package is targeted.
   *
   * The probe depends on package visibility: the `<queries>` block in
   * AndroidManifest.xml is what lets this module see the browser at all on
   * API 30+. Without it `resolveActivity` returns null for every candidate and
   * the whole dialog goes dead, so the launch below is written to work with or
   * without a pin.
   *
   * Resolves true when the URL was launched (pinned to the browser when one was
   * resolvable), false only when the platform refused the intent outright.
   */
  @ReactMethod
  fun openInBrowser(url: String, promise: Promise) {
    try {
      val pm = reactApplicationContext.packageManager
      val target = Uri.parse(url)
      val browserPackage = try {
        val probe = Intent(Intent.ACTION_VIEW, Uri.parse("http://example.com"))
            .addCategory(Intent.CATEGORY_BROWSABLE)
        pm.resolveActivity(probe, PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo?.packageName
      } catch (e: Exception) {
        null
      }

      // Start from a plain VIEW intent so there is ALWAYS something to launch.
      // The browser pin is an improvement on top, never a precondition — if
      // package visibility ever hides the browser again the link must still
      // open somewhere rather than resolve(false) and become a dead tile.
      val intent = Intent(Intent.ACTION_VIEW, target).apply {
        addCategory(Intent.CATEGORY_BROWSABLE)
        addCategory(Intent.CATEGORY_DEFAULT)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      browserPackage?.let { intent.setPackage(it) }

      try {
        reactApplicationContext.startActivity(intent)
        // True also when no browser was resolvable: the URL was still launched,
        // just possibly by a dedicated app for that domain.
        promise.resolve(true)
      } catch (e: Exception) {
        if (browserPackage != null) {
          // The pinned browser refused (disabled / not exported) — retry with
          // no package so the user still reaches the link.
          try {
            intent.setPackage(null)
            reactApplicationContext.startActivity(intent)
            promise.resolve(true)
            return
          } catch (retry: Exception) {
            // fall through to the failure below
          }
        }
        promise.resolve(false)
      }
    } catch (e: Exception) {
      promise.resolve(false)
    }
  }

  /**
   * Shrinks the activity into Android's picture-in-picture window.
   *
   * Needs `android:supportsPictureInPicture` on the activity (declared in the
   * manifest) and API 26+. Every failure resolves false rather than rejecting,
   * so the player simply stays full screen on devices that cannot do it.
   */
  @ReactMethod
  fun enterPictureInPicture(promise: Promise) {
    try {
      val activity = reactApplicationContext.currentActivity
      if (activity == null || android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.O) {
        promise.resolve(false)
        return
      }
      val params = android.app.PictureInPictureParams.Builder()
          .setAspectRatio(
              android.util.Rational(
                  reactApplicationContext.resources.displayMetrics.widthPixels,
                  reactApplicationContext.resources.displayMetrics.heightPixels))
          .build()
      activity.enterPictureInPictureMode(params)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.resolve(false)
    }
  }

  /**
 * Whether this device actually has a DECODER for a MIME type.
 *
 * The player used to answer every playback failure with "this device cannot
 * decode this format". That was untrue for most of the failures it was shown for
 * — a file the app is not allowed to open fails long before any decoder is
 * consulted — so the codec claim is now checked against the platform's real
 * codec list before it is ever made.
 */
  /**
   * The MIME type of the first VIDEO track inside a media file, or null.
   *
   * `MediaExtractor` parses the container, so this reports the codec that is
   * really inside - `video/mpeg2` for a satellite .ts capture, `video/avc` for
   * that very same container remuxed to H.264.
   *
   * Neither the file extension nor MediaStore's MIME can tell those two apart,
   * and on this device they are the difference between a picture and a silent
   * black screen.
   *
   * Needed because the player library's own `videoTracks[].codecs` is unreliable.
   * Measured here: it reported "avc1.640016" for an H.264 file but an EMPTY
   * STRING for an MPEG-2 one, so a check built on it stays silent exactly where
   * it is needed most.
   */
  @ReactMethod
  fun probeVideoMime(uri: String, promise: Promise) {
    var extractor: MediaExtractor? = null
    try {
      val parsed =
          when {
            uri.isBlank() -> null
            uri.startsWith("content://") || uri.startsWith("file://") -> Uri.parse(uri)
            else -> Uri.fromFile(java.io.File(uri))
          }
      if (parsed == null) {
        promise.resolve(null)
        return
      }
      extractor = MediaExtractor()
      extractor.setDataSource(reactApplicationContext, parsed, null)
      for (i in 0 until extractor.trackCount) {
        val mime = extractor.getTrackFormat(i).getString(MediaFormat.KEY_MIME) ?: continue
        if (mime.startsWith("video/")) {
          promise.resolve(mime)
          return
        }
      }
      promise.resolve(null)
    } catch (e: Exception) {
      // A file that cannot be parsed at all has no video track to report.
      promise.resolve(null)
    } finally {
      try {
        extractor?.release()
      } catch (e: Exception) {
        // Releasing twice is harmless.
      }
    }
  }

  /**
   * The MIME type of EVERY audio track in the file, in container order, or null
   * when the file cannot be parsed at all.
   *
   * FALLBACK ONLY. The primary source for the silent-video check is ExoPlayer's * own `audioTracks` from `onLoad`, because the platform extractor HIDES an * audio track whose codec this device cannot decode: measured on this handset, * the same MKV lists 2 tracks for AAC / FLAC / Opus and only the video track * for AC-3 / E-AC-3 (ffmpeg confirms both streams are in the file). Probing * here therefore cannot see the very codec that needs explaining, so it is * consulted only when ExoPlayer reports nothing at all.
   *
   * Where it does return a list, ExoPlayer auto-selects a decodable track when * one exists, so ANY decodable entry means playback is fine and the check * stays silent — a list where every track is undecodable is the only case * worth reporting.
   */
  @ReactMethod
  fun probeAudioMimes(uri: String, promise: Promise) {
    var extractor: MediaExtractor? = null
    try {
      val parsed =
          when {
            uri.isBlank() -> null
            uri.startsWith("content://") || uri.startsWith("file://") -> Uri.parse(uri)
            else -> Uri.fromFile(java.io.File(uri))
          }
      if (parsed == null) {
        promise.resolve(null)
        return
      }
      extractor = MediaExtractor()
      extractor.setDataSource(reactApplicationContext, parsed, null)
      val mimes = com.facebook.react.bridge.Arguments.createArray()
      for (i in 0 until extractor.trackCount) {
        val mime = extractor.getTrackFormat(i).getString(MediaFormat.KEY_MIME) ?: continue
        if (mime.startsWith("audio/")) mimes.pushString(mime)
      }
      promise.resolve(mimes)
    } catch (e: Exception) {
      // A file that cannot be parsed has no audio tracks to report.
      promise.resolve(null)
    } finally {
      try {
        extractor?.release()
      } catch (e: Exception) {
        // Releasing twice is harmless.
      }
    }
  }

@ReactMethod
fun canDecodeMime(mime: String, promise: Promise) {
  try {
    if (mime.isBlank()) {
      promise.resolve(false)
      return
    }
    val list =
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
          MediaCodecList(MediaCodecList.REGULAR_CODECS)
        } else {
          @Suppress("DEPRECATION") MediaCodecList(0)
        }
    val found =
        list.codecInfos.any { info ->
          !info.isEncoder && info.supportedTypes.any { it.equals(mime, ignoreCase = true) }
        }
    promise.resolve(found)
  } catch (e: Exception) {
    promise.resolve(false)
  }
}

/**
 * True when the app holds "All files access".
 *
 * Without it, Android's scoped storage refuses a direct read of any file the
 * media store has never indexed — which is exactly what happens to an unusual
 * extension such as `.t`. Such a file can still be opened through a `content://`
 * URI, but when there is no media row for it either, this permission is the only
 * way in.
 */
@ReactMethod
fun hasAllFilesAccess(promise: Promise) {
  try {
    if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.R) {
      promise.resolve(true)
      return
    }
    val granted =
        reactApplicationContext.checkSelfPermission(
            android.Manifest.permission.MANAGE_EXTERNAL_STORAGE) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED
    promise.resolve(granted)
  } catch (e: Exception) {
    promise.resolve(false)
  }
}

/** Opens the system page where "All files access" is granted. */
@ReactMethod
fun openAllFilesAccessSettings(promise: Promise) {
  try {
    val pkg = reactApplicationContext.packageName
    val direct =
        Intent(
                android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                Uri.parse("package:$pkg"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      reactApplicationContext.startActivity(direct)
      promise.resolve(true)
    } catch (e: Exception) {
      // Some builds have no per-app page; fall back to the app details screen.
      val fallback =
          Intent(
                  android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                  Uri.parse("package:$pkg"))
              .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      reactApplicationContext.startActivity(fallback)
      promise.resolve(true)
    }
  } catch (e: Exception) {
    promise.resolve(false)
  }
}

// --- physical device orientation ----------------------------------------

  private var rotationListener: SensorEventListener? = null
  private var lastDeviceOrientation: String? = null

  private fun emit(name: String, payload: String) {
    try {
      reactApplicationContext
          .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit(name, payload)
    } catch (e: Exception) {
      android.util.Log.w("MoviraJS", "event '$name' dropped, no React context", e)
    }
  }

  /**
   * Starts reporting the handset's PHYSICAL orientation as it is turned.
   *
   * This exists because the window cannot report its own rotation while it is
   * pinned. Forcing a landscape video to `SCREEN_ORIENTATION_LANDSCAPE` makes the
   * activity ignore the accelerometer completely, so nothing in the system fires
   * a configuration change when the user turns the phone and the screen simply
   * never changes. Reading the accelerometer directly is the only way to notice.
   *
   * `TYPE_GRAVITY` is preferred because it is already filtered out of the
   * movement of the hand; the accelerometer is the fallback on devices without
   * it.
   *
   * No value is emitted on start: the caller only cares about CHANGES, and an
   * opening reading would immediately fight the orientation it just chose from
   * the video's aspect ratio.
   */
  @ReactMethod
  fun startDeviceOrientationWatch() {
    if (rotationListener != null) return
    val manager = reactApplicationContext.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
    if (manager == null) return
    val sensor =
        manager.getDefaultSensor(Sensor.TYPE_GRAVITY)
            ?: manager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
            ?: return

    val listener =
        object : SensorEventListener {
          override fun onSensorChanged(event: SensorEvent) {
            // The accelerometer reads +g along whichever device axis currently
            // points at the sky.
            val x = event.values[0].toDouble() // device right edge
            val y = event.values[1].toDouble() // device top edge

            // LYING FLAT IS NOT AN ORIENTATION.
            //
            // Face up on a desk, gravity runs along the device's Z axis and
            // NOTHING lands in the screen plane, so the length of (x, y) is the
            // test — not either axis on its own. That distinction was the bug:
            // deciding from the vertical axis alone also made a phone held
            // exactly side-on (vertical reading ~0, horizontal reading large)
            // look "flat", so BOTH true landscape positions were thrown away and
            // the opposite side was only ever recognised once the phone had been
            // turned most of the way round.
            if (Math.hypot(x, y) < ORIENTATION_FLAT_EPSILON) return

            // Direction, in the device's own frame, that currently points at the
            // sky. This is the quantity that actually describes how the phone is
            // being held, and it distinguishes the two landscape sides:
            //
            //    90 deg = upright portrait
            //     0 deg = on its side, one way   -> landscape
            //   180 deg = on its side, the other -> the opposite landscape
            //   270 deg = upside-down portrait
            //
            // Measured as a direction rather than as sign tests on one axis, so
            // every side-on position is recognised the moment it is reached
            // instead of after the phone has been rotated far past it.
            var angle = Math.toDegrees(Math.atan2(y, x))
            if (angle < 0) angle += 360.0

            // Snap to the nearest of the four side-on directions, and only accept
            // it once it is comfortably inside one. The dead band is what stops a
            // phone held near a boundary from flickering between two
            // orientations, while still switching within ~20 degrees of the true
            // transition rather than only once the phone is well past it.
            var nearest = -1
            var nearestGap = Double.MAX_VALUE
            var i = 0
            while (i < SKY_DIRECTION_TARGETS.size) {
              var gap = Math.abs(angle - SKY_DIRECTION_TARGETS[i])
              if (gap > 180.0) gap = 360.0 - gap
              if (gap < nearestGap) {
                nearestGap = gap
                nearest = i
              }
              i++
            }
            // Between the side-on directions there is no honest answer, so the
            // last known orientation stands.
            if (nearest < 0 || nearestGap > ORIENTATION_DEAD_BAND_DEGREES) return

            val orientation =
                when (nearest) {
                  0 -> "landscape"
                  2 -> "reverseLandscape"
                  // 1 is upright portrait, 3 is upside-down portrait. The
                  // upside-down case deliberately reports portrait: flipping the
                  // whole player because the phone was tipped over is far more
                  // surprising than not reacting.
                  else -> "portrait"
                }
            // Only on a real change, so a phone held still costs nothing.
            if (orientation != lastDeviceOrientation) {
              lastDeviceOrientation = orientation
              emit(EVENT_DEVICE_ORIENTATION, orientation)
            }
          }

          override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
        }
    rotationListener = listener
    manager.registerListener(listener, sensor, SensorManager.SENSOR_DELAY_UI)
  }

  /** Stops the watcher. Called from JavaScript when the player goes away. */
  @ReactMethod
  fun stopDeviceOrientationWatch() {
    val listener = rotationListener ?: return
    rotationListener = null
    lastDeviceOrientation = null
    try {
      val manager = reactApplicationContext.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
      manager?.unregisterListener(listener)
    } catch (e: Exception) {
      // Already gone; nothing to release.
    }
  }

  /**
   * Belt and braces: the listener must never outlive the module, or the sensor
   * stays registered and keeps the sensor awake for the whole process lifetime.
   */
  override fun invalidate() {
    val listener = rotationListener
    if (listener != null) {
      rotationListener = null
      lastDeviceOrientation = null
      try {
        val manager = reactApplicationContext.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
        manager?.unregisterListener(listener)
      } catch (e: Exception) {
        // Nothing to do.
      }
    }
    super.invalidate()
  }

  // Required no-ops so RN does not warn about a missing event emitter.
  @ReactMethod fun addListener(eventName: String) = Unit

  /**
   * Mirrors a JS string into logcat under the "MoviraJS" tag. Release builds
   * strip console.*, so this is the only channel that survives a release
   * bundle — it is what makes a caught render error diagnosable on device.
   */
  @ReactMethod
  fun log(message: String) {
    android.util.Log.i("MoviraJS", message)
  }

  @ReactMethod fun removeListeners(count: Double) = Unit
}
