import { del, fmtDuration } from '../api';
import { Empty, Header } from '../components/ui';
import { JobStatus, useApp } from '../store';

const timeFmt = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export default function Jobs() {
  const { jobs, openJob } = useApp();
  const finished = jobs.filter((j) => j.status !== 'running');
  return (
    <>
      <Header
        title="İşler"
        subtitle="Panelden başlatılan komutlar"
        actions={
          finished.length > 0 && (
            <button className="btn btn-sm btn-ghost" onClick={() => finished.forEach((j) => del(`/api/jobs/${j.id}`).catch(() => {}))}>
              Bitenleri temizle
            </button>
          )
        }
      />
      <div className="content">
        {jobs.length === 0 ? (
          <Empty icon="list" title="Henüz iş yok">
            Paket kurulumu, kısayol çalıştırma gibi işlemler burada listelenir.
          </Empty>
        ) : (
          <div className="list">
            {jobs.map((j) => (
              <button key={j.id} className="list-item" onClick={() => openJob(j.id)}>
                <div className="list-main">
                  <div className="list-title">{j.title}</div>
                  <div className="list-sub">
                    {timeFmt.format(j.startedAt)}
                    {j.endedAt && ` · ${fmtDuration(Math.max(1, (j.endedAt - j.startedAt) / 1000))}`}
                  </div>
                </div>
                <JobStatus status={j.status} />
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
