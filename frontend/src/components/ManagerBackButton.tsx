import { Link } from 'react-router-dom'

export default function ManagerBackButton() {
  return (
    <Link
      to="/manager"
      className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-sky-400 transition-colors mb-4 group"
    >
      <span className="group-hover:-translate-x-0.5 transition-transform">←</span>
      <span>Panel Manager</span>
    </Link>
  )
}
