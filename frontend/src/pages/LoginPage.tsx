import { FormEvent, useState } from 'react';
import { AlertCircle, ArrowRight, Compass, DatabaseZap, LockKeyhole, Map, RadioTower } from 'lucide-react';
import { login, me, register } from '../api/client';
import type { Session } from '../auth/session';

type Props = {
  onAuthenticated: (session: Session) => void;
};

type LoginLanguage = 'en' | 'mi';

const LOGIN_TEXT = {
  en: {
    languageName: 'English',
    otherLanguageName: 'Te reo Māori',
    networkConsole: 'Auckland network console',
    headline: 'Live routes, stops, alerts, and departures from real GTFS data.',
    capabilities: {
      gtfs: 'PostGIS GTFS store',
      realtime: 'Redis realtime feed',
      map: 'MapLibre route view',
    },
    signInLabel: 'Sign in',
    secureWorkspace: 'Secure workspace',
    welcomeBack: 'Welcome back',
    createAccount: 'Create account',
    authMode: 'Authentication mode',
    login: 'Login',
    register: 'Register',
    email: 'Email',
    password: 'Password',
    authFailed: 'Authentication failed',
    checking: 'Checking credentials',
    openMap: 'Open map',
    createAndOpen: 'Create and open map',
  },
  mi: {
    languageName: 'Te reo Māori',
    otherLanguageName: 'English',
    networkConsole: 'Papatohu whatunga o Tāmaki Makaurau',
    headline: 'Ngā ararere, ngā tūnga, ngā whakatūpato me ngā wehenga mai i ngā raraunga GTFS tūturu.',
    capabilities: {
      gtfs: 'Pātaka GTFS PostGIS',
      realtime: 'Whāngai wā-tūturu Redis',
      map: 'Tirohanga ararere MapLibre',
    },
    signInLabel: 'Takiuru',
    secureWorkspace: 'Wāhi mahi haumaru',
    welcomeBack: 'Nau mai hoki mai',
    createAccount: 'Waihanga pūkete',
    authMode: 'Aratau whakamana',
    login: 'Takiuru',
    register: 'Rēhita',
    email: 'Īmēra',
    password: 'Kupuhipa',
    authFailed: 'I rahua te whakamana',
    checking: 'E arowhai ana i ngā taipitopito',
    openMap: 'Whakatūwhera mahere',
    createAndOpen: 'Waihanga, ka whakatūwhera mahere',
  },
} as const;

export function LoginPage({ onAuthenticated }: Props) {
  const [language, setLanguage] = useState<LoginLanguage>('en');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const t = LOGIN_TEXT[language];

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = mode === 'login' ? await login(email, password) : await register(email, password);
      const user = await me();
      onAuthenticated({ email: user.email || result.user.email });
    } catch (err) {
      setError(err instanceof Error ? err.message : t.authFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-hero">
        <nav className="login-brand" aria-label="Product">
          <Compass size={26} />
          <strong>AT Public Note</strong>
          <button
            className="language-toggle"
            onClick={() => setLanguage((current) => (current === 'en' ? 'mi' : 'en'))}
            title={t.otherLanguageName}
            type="button"
          >
            {language === 'en' ? 'MI' : 'EN'}
          </button>
        </nav>
        <div className="login-copy">
          <p>{t.networkConsole}</p>
          <h1>{t.headline}</h1>
        </div>
        <div className="capability-grid" aria-label="Capabilities">
          <span><DatabaseZap size={18} /> {t.capabilities.gtfs}</span>
          <span><RadioTower size={18} /> {t.capabilities.realtime}</span>
          <span><Map size={18} /> {t.capabilities.map}</span>
        </div>
      </section>

      <section className="login-panel" aria-label={t.signInLabel}>
        <div>
          <p className="eyebrow">{t.secureWorkspace}</p>
          <h2>{mode === 'login' ? t.welcomeBack : t.createAccount}</h2>
        </div>

        <div className="segmented" role="tablist" aria-label={t.authMode}>
          <button className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')} type="button">{t.login}</button>
          <button className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')} type="button">{t.register}</button>
        </div>

        <form onSubmit={submit} className="login-form">
          <label>
            {t.email}
            <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" required />
          </label>
          <label>
            {t.password}
            <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" minLength={8} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required />
          </label>

          {error && (
            <p className="form-error">
              <AlertCircle size={16} />
              {error}
            </p>
          )}

          <button className="primary-action" disabled={busy} type="submit">
            <LockKeyhole size={17} />
            {busy ? t.checking : mode === 'login' ? t.openMap : t.createAndOpen}
            <ArrowRight size={17} />
          </button>
        </form>
      </section>
    </main>
  );
}
