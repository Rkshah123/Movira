package com.movira.player

import android.app.PendingIntent
import android.content.Intent
import android.os.Bundle
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  /**
   * Android's own "Allow Movira to delete this file?" prompt.
   *
   * `MediaStore.createDeleteRequest` returns a PendingIntent, and in the android-36
   * SDK stub `PendingIntent.getIntent()` is no longer exposed — only
   * `getIntentSender()` is. A PendingIntent *is* an IntentSender, so the supported
   * launcher accepts it directly and nothing has to be reflected around.
   *
   * `registerForActivityResult` is only legal before the activity is started, which
   * is why it lives here rather than being created when a delete is requested.
   */
  private val deleteMediaLauncher: ActivityResultLauncher<IntentSenderRequest> =
      registerForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { result ->
        val approved = result.resultCode == RESULT_OK
        // Static, deliberately. Going back through `reactInstanceManager` to find
        // the module failed here: by the time the system activity closed, the React
        // context was not reachable, so the deletion result was dropped and the
        // promise never settled.
        MoviraSystemModule.deliverDeleteMediaResult(approved)
        bringToFront()
      }

  /**
   * Return to Movira after the delete prompt.
   *
   * The prompt runs as a separate system activity, and because MainActivity is
   * declared `singleTask` the task dropped to the launcher when it closed — so
   * answering "Allow" threw the user out of the app. A plain intent with no action
   * and no data is a no-op for the open-with listener, which ignores anything that
   * is not a media VIEW.
   */
  private fun bringToFront() {
    try {
      startActivity(
          Intent(this, MainActivity::class.java)
              .addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP))
    } catch (e: Exception) {
      // Nothing to recover to; the result has already been delivered.
    }
  }

  /**
   * Shows the platform delete confirmation for a MediaStore request.
   *
   * Returns false when the launcher cannot be reached, so the caller can report a
   * plain failure rather than leaving a promise pending forever.
   */
  fun launchMediaDelete(request: PendingIntent): Boolean =
      try {
        deleteMediaLauncher.launch(IntentSenderRequest.Builder(request).build())
        true
      } catch (e: Exception) {
        false
      }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
  }

  override fun getMainComponentName(): String = "Movira"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
