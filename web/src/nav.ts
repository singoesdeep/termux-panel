import type { Page } from './router';

export const MORE_NAV: { page: Page; label: string; icon: string; desc: string }[] = [
  { page: 'setup', label: 'Kurulum', icon: 'check', desc: 'Termux, Linux ortamı ve Claude Code için hızlı kurulum' },
  { page: 'claude', label: 'Claude', icon: 'message', desc: 'claude rc: Remote Control servisi, bağlantı ve loglar' },
  { page: 'distros', label: 'Distrolar', icon: 'box', desc: 'proot-distro: Debian, Ubuntu… kur, yedekle, oturumlar' },
  { page: 'processes', label: 'Süreçler', icon: 'activity', desc: 'Çalışan programlar, CPU ve bellek' },
  { page: 'services', label: 'Servisler', icon: 'server', desc: 'termux-services ile arka plan servisleri' },
  { page: 'devtools', label: 'Python & Node', icon: 'code', desc: 'pip ve global npm paketleri' },
  { page: 'shortcuts', label: 'Kısayollar', icon: 'zap', desc: 'Kayıtlı komutları tek dokunuşla çalıştır' },
  { page: 'device', label: 'Cihaz', icon: 'phone', desc: 'Termux:API — pil, fener, pano, bildirim' },
  { page: 'jobs', label: 'İşler', icon: 'list', desc: 'Arka planda çalışan komutlar ve çıktıları' },
];
