import type { SVGProps } from 'react';

export type IconName =
  | 'arrow-up'
  | 'check'
  | 'clipboard'
  | 'clock'
  | 'cloud-off'
  | 'copy'
  | 'delete'
  | 'devices'
  | 'download'
  | 'file'
  | 'inbox'
  | 'install'
  | 'link'
  | 'menu'
  | 'note'
  | 'open'
  | 'refresh'
  | 'retry'
  | 'search'
  | 'send'
  | 'settings'
  | 'wifi'
  | 'x';

const paths: Record<IconName, React.ReactNode> = {
  'arrow-up': <path d="m12 19 7-7-7-7m7 7H5" />,
  check: <path d="m5 12 4 4L19 6" />,
  clipboard: <><rect x="7" y="4" width="10" height="16" rx="2" /><path d="M9 4.5V3h6v1.5M9 9h6m-6 4h6" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  'cloud-off': <><path d="M5 5 19 19" /><path d="M7.2 7.2A7 7 0 0 1 18.6 10 4.5 4.5 0 0 1 18 19H8a5 5 0 0 1-1.8-9.7" /></>,
  copy: <><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
  delete: <><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7" /><path d="M10 11v5m4-5v5" /></>,
  devices: <><rect x="3" y="5" width="13" height="10" rx="2" /><path d="M8 19h3m-1.5-4v4" /><rect x="17" y="8" width="4" height="9" rx="1" /></>,
  download: <><path d="M12 3v12m-5-5 5 5 5-5" /><path d="M5 20h14" /></>,
  file: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h5" /></>,
  inbox: <><path d="M4 5h16l2 9v5H2v-5z" /><path d="M2 14h5l2 3h6l2-3h5" /></>,
  install: <><path d="M12 3v12m-5-5 5 5 5-5" /><rect x="4" y="18" width="16" height="3" rx="1" /></>,
  link: <><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1.1" /><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1.1" /></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  note: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8m-8 4h8m-8 4h5" /></>,
  open: <><path d="M14 4h6v6m0-6-9 9" /><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" /></>,
  refresh: <><path d="M20 6v5h-5" /><path d="M18.5 9A7.5 7.5 0 1 0 19 15" /></>,
  retry: <><path d="M20 6v5h-5" /><path d="M18.5 9A7.5 7.5 0 1 0 19 15" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m16 16 5 5" /></>,
  send: <><path d="m3 11 18-8-8 18-2-8z" /><path d="m11 13 4-4" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9A1.7 1.7 0 0 0 21 10h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></>,
  wifi: <><path d="M3 9a14 14 0 0 1 18 0M6 13a9 9 0 0 1 12 0m-8.5 4a4 4 0 0 1 5 0" /><circle cx="12" cy="20" r="1" fill="currentColor" stroke="none" /></>,
  x: <path d="M5 5l14 14M19 5 5 19" />,
};

export function Icon({ name, size = 20, ...props }: SVGProps<SVGSVGElement> & { name: IconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
