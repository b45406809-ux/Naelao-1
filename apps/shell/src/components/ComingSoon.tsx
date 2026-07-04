export function ComingSoon({ title, note }: { title: string; note: string }) {
  return (
    <div className="page-view">
      <div className="page-header">
        <div className="page-title">{title}</div>
        <div className="page-subtitle">{note}</div>
      </div>
    </div>
  );
}
