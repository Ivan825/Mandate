import { loginAction } from "@/app/auth-actions";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <div style={{ maxWidth: 380, margin: "60px auto" }}>
      <h1>Sign in</h1>
      <p className="muted" style={{ margin: "8px 0 16px" }}>This dashboard controls what your agents may spend. It's yours alone.</p>
      {error && <div className="notice bad" style={{ marginBottom: 12 }}>That password didn't match.</div>}
      <form action={loginAction} className="form card">
        <div className="field"><label htmlFor="password">Password</label><input id="password" name="password" type="password" autoFocus required /></div>
        <button className="btn accent" type="submit">Sign in</button>
      </form>
    </div>
  );
}
