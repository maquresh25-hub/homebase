import { fb } from "./firebase.js";
import { toast } from "./toast.js";
import { $ } from "./util.js";


// ================================================================ AUTH
const AUTH_MESSAGES = {
  "auth/invalid-credential": "That email or password isn't right.",
  "auth/wrong-password": "That email or password isn't right.",
  "auth/user-not-found": "That email or password isn't right.",
  "auth/invalid-email": "That email doesn't look right.",
  "auth/too-many-requests": "Too many tries. Wait a few minutes, then try again.",
  "auth/network-request-failed": "No internet connection. Connect and try again.",
  "auth/user-disabled": "This account has been turned off.",
};

function showSignIn(show) {
  $("signin").hidden = !show;
  document.querySelector(".app").setAttribute("aria-hidden", show ? "true" : "false");
  if (show) setTimeout(() => $("signin-email").focus(), 50);
}

function wireSignIn() {
  $("signin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("signin-email").value.trim();
    const password = $("signin-password").value;
    const err = $("signin-error");
    err.textContent = "";
    if (!email || !password) { err.textContent = "Enter your email and password."; return; }
    if (!fb) { err.textContent = "Still loading. Try again in a moment."; return; }
    const btn = $("signin-btn");
    btn.disabled = true;
    btn.textContent = "Signing in…";
    try {
      await fb.signInWithEmailAndPassword(fb.auth, email, password);
      $("signin-password").value = "";
    } catch (ex) {
      err.textContent = AUTH_MESSAGES[ex.code] || "Couldn't sign in. Try again.";
    } finally {
      btn.disabled = false;
      btn.textContent = "Sign in";
    }
  });

  $("forgot-btn").addEventListener("click", async () => {
    const email = $("signin-email").value.trim();
    const err = $("signin-error");
    if (!email) { err.textContent = "Type your email first, then tap Forgot password."; return; }
    if (!fb) return;
    try {
      await fb.sendPasswordResetEmail(fb.auth, email);
      err.textContent = "";
      toast("Check your email for a reset link.");
    } catch (ex) {
      err.textContent = AUTH_MESSAGES[ex.code] || "Couldn't send the email. Try again.";
    }
  });

  $("signout-btn").addEventListener("click", () => fb && fb.signOut(fb.auth));
}

export { showSignIn, wireSignIn };
