import { api, setUnauthorizedHandler } from "./api";
import { installRouter } from "./router";
import { store } from "./store";
import { connectSession } from "./ws";
import "./app";
import { SignIn } from "./account";

// With -auth local the application needs a signed-in account; otherwise the
// sign-in page (or, on a new server, "create the first account") replaces it.
async function start() {
  const auth = await api.auth().catch(() => null); // unreachable: start anyway and show "server unreachable"
  if (auth?.mode === "local" && !auth.account) {
    const page = new SignIn();
    page.setup = !!auth.setup;
    document.querySelector("corestone-app")?.replaceWith(page);
    return;
  }
  if (auth?.account) {
    store.setAccount(auth.account);
    setUnauthorizedHandler(() => location.reload()); // the session ended: back to signing in
  }
  installRouter();
  connectSession();
}

void start();
