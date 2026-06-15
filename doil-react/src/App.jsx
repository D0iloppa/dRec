import { useState, useEffect } from 'react';
import {
  FaGithub, FaMotorcycle, FaReact, FaFlask, FaInstagram, FaLinkedin
} from 'react-icons/fa';
import {
  SiNaver, SiSpringboot, SiNotion, SiBuymeacoffee,
  SiMattermost, SiObsidian
} from 'react-icons/si';
import { RiBookmarkLine } from 'react-icons/ri';
import './App.css';

// Google AdSense — 페이지 최하단 광고. 콘솔에서 만든 디스플레이 유닛의 data-ad-slot 숫자를 넣으면 켜짐.
// 빈 값이면 렌더하지 않음. 로더 스크립트는 index.html <head> 에 있음.
const ADSENSE_CLIENT = 'ca-pub-4322659154168202';
const ADSENSE_SLOT = '3606107040';

function AdUnit() {
  useEffect(() => {
    if (!ADSENSE_SLOT) return;
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch { /* 로더 미로드 */ }
  }, []);
  if (!ADSENSE_SLOT) return null;
  return (
    <ins className="adsbygoogle"
      style={{ display: 'block', margin: '14px auto' }}
      data-ad-client={ADSENSE_CLIENT}
      data-ad-slot={ADSENSE_SLOT}
      data-ad-format="auto"
      data-full-width-responsive="true" />
  );
}

const SERVICES = [
  {
    icon: '🎮',
    title: 'DOPL',
    desc: '실시간 멀티플레이 게임 플랫폼 (doil playground).',
    href: 'https://dopl.doil.me/',
    badge: 'public',
    badgeLabel: 'Public',
  },
  {
    icon: '🍽️',
    title: 'Can I Eat?',
    desc: '간헐적 단식 코치 — "지금 먹어도 돼?"를 AI가 판단.',
    href: 'https://cie.doil.me/',
    badge: 'public',
    badgeLabel: 'Public',
  },
  {
    icon: '🐳',
    title: 'SandBox Page',
    desc: '테스트 및 샌드박스 환경 페이지입니다.',
    href: '/sb/',
    badge: 'public',
    badgeLabel: 'Public',
  },
  {
    icon: '📚',
    title: 'Developer Wiki',
    desc: '역사는 흐른다',
    href: '/wiki/',
    badge: 'public',
    badgeLabel: 'Public',
  },
  {
    icon: '🪙',
    title: 'Oh!NO',
    desc: 'SaaS 랜딩 페이지 및 메인 서비스 포털.',
    href: 'https://ohno.doil.me/landing',
    badge: 'public',
    badgeLabel: 'Public',
  },
  {
    icon: '🏍️',
    title: 'SaigonRider',
    desc: '동남아 오토바이 커뮤니티 서비스 페이지.',
    href: 'https://saigon.doil.me/',
    badge: 'public',
    badgeLabel: 'Public',
  },
  {
    icon: '✈️',
    title: 'Plane',
    desc: '프로젝트 관리 및 이슈 트래킹.',
    href: 'https://plane.doil.me/',
    badge: 'private',
    badgeLabel: 'Internal',
  },
  {
    icon: <SiObsidian />,
    title: 'Obsidian Sync',
    desc: 'LiveSync 동기화 서버 (CouchDB). 각 기기 네이티브 앱이 여기로 동기화.',
    href: 'https://docs.doil.me/_utils/',
    badge: 'private',
    badgeLabel: 'Internal',
  },
  {
    icon: <RiBookmarkLine />,
    title: 'Doybrary',
    desc: '알렉산드리아 도서관',
    href: 'https://doybrary.doil.me/',
    badge: 'public',
    badgeLabel: 'Public',
  },
  {
    icon: <SiNotion />,
    title: 'Resume',
    desc: 'Doil의 이력서 (Notion).',
    href: 'https://doiloppa.notion.site/22c3bd6b405d80bab5decf184db29072',
    badge: 'public',
    badgeLabel: 'Public',
  },
  {
    icon: <SiMattermost />,
    title: 'Mattermost',
    desc: '내부 메시징 및 파일 공유 채널.',
    href: '/mm/',
    badge: 'private',
    badgeLabel: 'Internal',
  },
  {
    icon: <SiSpringboot />,
    title: 'Spring API',
    desc: 'lsh_api 기반 레거시 Spring 백엔드 (deprecated).',
    href: '/lsh_api/',
    badge: 'private',
    badgeLabel: 'deprecated',
  },
  {
    icon: <FaReact />,
    title: 'React App',
    desc: 'lsh 기반 레거시 React 프론트엔드 (deprecated).',
    href: '/lsh/',
    badge: 'private',
    badgeLabel: 'deprecated',
  },
];

function useServiceStatus(href) {
  const [status, setStatus] = useState('coma');

  useEffect(() => {
    const isExternal = href.startsWith('http');
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch(href, {
          method: isExternal ? 'GET' : 'HEAD',
          signal: AbortSignal.timeout(isExternal ? 8000 : 5000),
          ...(isExternal && { mode: 'no-cors' }),
        });
        if (cancelled) return;
        // no-cors 외부 요청은 opaque response라 res.ok가 항상 false → 응답 자체가 성공이면 live
        setStatus(isExternal ? 'live' : res.ok ? 'live' : 'coma');
      } catch {
        if (!cancelled) setStatus('coma');
      }
    };
    check();
    return () => { cancelled = true; };
  }, [href]);

  return status;
}

function ServiceCard({ icon, title, desc, href, badge, badgeLabel }) {
  const status = useServiceStatus(href);

  return (
    <a href={href} className="serviceCard" target="_blank" rel="noreferrer">
      <span className={`statusBadge statusBadge--${status}`}>
        <span className="statusDot" />
        {status}
      </span>
      <div className="serviceCardHeader">
        <div className="serviceCardIcon">
          {typeof icon === 'string'
            ? <span className="serviceCardEmoji">{icon}</span>
            : icon}
        </div>
        <div className="serviceCardTitle">{title}</div>
      </div>
      <div className="serviceCardDesc">{desc}</div>
      <span className={`serviceCardBadge badge--${badge}`}>{badgeLabel}</span>
    </a>
  );
}

const HERO_SUBTITLES = [
  '🐳 Full Stack Engineer & DevOps Enthusiast',
  '好雨知時節',
  '😮‍💨 Shipping things that actually work.',
  '神は細部に宿る'
];

function useTypewriter(texts, { typeSpeed = 55, deleteSpeed = 30, pauseMs = 2000, gapMs = 450 } = {}) {
  const [display, setDisplay] = useState('');
  const [idx, setIdx] = useState(0);
  const [phase, setPhase] = useState('typing');

  useEffect(() => {
    const text = texts[idx];
    let timer;
    if (phase === 'typing') {
      if (display.length < text.length) {
        timer = setTimeout(() => setDisplay(text.slice(0, display.length + 1)), typeSpeed);
      } else {
        timer = setTimeout(() => setPhase('deleting'), pauseMs);
      }
    } else {
      if (display.length > 0) {
        timer = setTimeout(() => setDisplay(display.slice(0, -1)), deleteSpeed);
      } else {
        timer = setTimeout(() => {
          setIdx((i) => (i + 1) % texts.length);
          setPhase('typing');
        }, gapMs);
      }
    }
    return () => clearTimeout(timer);
  }, [display, phase, idx, texts, typeSpeed, deleteSpeed, pauseMs, gapMs]);

  return display;
}

function DoilTimesSection() {
  // null=로딩, []=발행물 없음, [...]=목록
  const [posts, setPosts] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/times/posts.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => { if (!cancelled) setPosts(Array.isArray(d) ? d.slice(0, 4) : []); })
      .catch(() => { if (!cancelled) setPosts([]); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="container" style={{ marginBottom: '2.5rem' }}>
      <div className="sectionHeader">
        <h2>📰 DoilTimes</h2>
        <p>AI가 매일 뉴스를 요약·논평하는 자동 브리핑 신문. <a href="/times/">전체 보기 →</a></p>
      </div>

      {posts === null ? (
        <p style={{ opacity: 0.6 }}>불러오는 중…</p>
      ) : posts.length === 0 ? (
        <p style={{ opacity: 0.6 }}>아직 발행된 글이 없습니다.</p>
      ) : (
        <div className="serviceGrid">
          {posts.map((p) => (
            <a key={p.url} href={p.url} className="serviceCard" target="_blank" rel="noreferrer">
              <div className="serviceCardTitle">{p.date}</div>
              <div className="serviceCardDesc">DoilTimes {p.edition}</div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function HeroSection() {
  const subtitle = useTypewriter(HERO_SUBTITLES);

  const socialLinks = [
    { icon: <FaGithub />, href: 'https://github.com/D0iloppa/', label: 'GIT' },
    { icon: <SiNaver />, href: 'https://blog.naver.com/kdi3939', label: 'BLOG' },
    { icon: <FaInstagram />, href: 'https://www.instagram.com/d0sigo_/', label: 'INSTA' },
    { icon: <SiNotion />, href: 'https://doiloppa.notion.site/22c3bd6b405d80bab5decf184db29072', label: 'RESUME' },
    { icon: <FaLinkedin />, href: 'https://www.linkedin.com/in/도일-권-939bb2301', label: 'LINKEDIN' },
    { icon: <SiBuymeacoffee />, href: 'https://buymeacoffee.com/doil', label: 'DONATE' }
  ];

  return (
    <header className="hero heroWiki">
      <div className="container heroFlex">
        <div className="heroLeft">
          <img src="/cdn/profile.webp" alt="Avatar" className="heroAvatar" />
        </div>
        <div className="heroRight">
          <div className="heroTextContent">
            <h1 className="heroTitle">D0il's DEV Gateway</h1>
            <p className="heroStatic">System Architecture &amp; Backend Development Portal</p>
            <div className="cliWindow">
              <div className="cliTitleBar">
                <span className="cliDot" />
                <span className="cliDot" />
                <span className="cliDot" />
                <span className="cliWindowTitle">doil@gw: ~</span>
              </div>
              <div className="cliBody">
                <span className="cliPrompt">doil@gw:~$</span>
                <span className="cliText">{subtitle}</span>
                <span className="typeCursor" />
              </div>
            </div>
          </div>
          <div className="heroSocialLinks">
            {socialLinks.map((link) => (
              <a key={link.label} href={link.href} className="socialLink" target="_blank" rel="noreferrer">
                <span className="socialLinkIcon">{link.icon}</span>
                <span className="socialLinkLabel">{link.label}</span>
              </a>
            ))}
          </div>
        </div>
      </div>
    </header>
  );
}

function App() {
  const [isLightMode, setIsLightMode] = useState(false);

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'light') {
      setIsLightMode(true);
      document.body.classList.add('light-mode');
    }
  }, []);

  const toggleTheme = () => {
    setIsLightMode((prev) => {
      const newMode = !prev;
      localStorage.setItem('theme', newMode ? 'light' : 'dark');
      document.body.classList.toggle('light-mode', newMode);
      return newMode;
    });
  };

  return (
    <div className="app-wrapper">
      <div className="theme-switch" onClick={toggleTheme} title="Toggle Theme">
        <span className="theme-icon sun-icon">☀️</span>
        <div className="theme-switch-container">
          <div className="switch-knob"></div>
        </div>
        <span className="theme-icon moon-icon">🌙</span>
      </div>

      <HeroSection />

      <main className="main-content">
        <DoilTimesSection />

        <div className="container">
          <div className="sectionHeader">
            <h2>✅ 서비스 일람</h2>
          </div>

          <div className="serviceGrid">
            {SERVICES.map((s) => (
              <ServiceCard key={s.title} {...s} />
            ))}
          </div>
        </div>
      </main>

      <footer>
        <div className="container">
          <AdUnit />
          <p>© 2026 D0il. Powered by Nginx Gateway. · <a href="/times/privacy.html">개인정보처리방침</a></p>
        </div>
      </footer>
    </div>
  );
}

export default App;