export default function AppVersion() {
  return <span className="app-version" aria-label={`应用版本 ${__APP_VERSION__}`} title={`应用版本 ${__APP_VERSION__}`}>v{__APP_VERSION__}</span>;
}
