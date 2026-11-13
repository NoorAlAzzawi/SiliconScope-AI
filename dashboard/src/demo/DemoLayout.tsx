import { Outlet, Link, useLocation } from 'react-router-dom';
import { DEMO_SESSION_A_ID, DEMO_SESSION_B_ID } from './fixtures';

const COMPARE_HREF = `/compare?a=${DEMO_SESSION_A_ID}&b=${DEMO_SESSION_B_ID}`;

export default function DemoLayout() {
  const { pathname } = useLocation();

  return (
    <>
      <div className="demo-banner" role="note" aria-label="Demo mode notice">
        Demo mode — all data is synthetic sample data. No backend connection.
      </div>
      <nav className="app-nav" aria-label="Application navigation">
        <Link to="/" className="nav-link">Runs</Link>
        <Link to="/compare" className="nav-link">Compare</Link>
      </nav>
      {pathname === '/' && (
        <div className="demo-cta" role="region" aria-label="Demo quick start">
          <p className="demo-cta-text">
            Explore two sample benchmark runs — one baseline, one candidate — across
            integer throughput, memory bandwidth, and cache access.
          </p>
          <Link to={COMPARE_HREF} className="btn demo-cta-btn" aria-label="Compare Demo Runs">
            Compare Demo Runs →
          </Link>
        </div>
      )}
      <Outlet />
    </>
  );
}
