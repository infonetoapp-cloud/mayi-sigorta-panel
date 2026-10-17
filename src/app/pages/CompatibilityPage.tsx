import { useNavigate } from 'react-router';
import { App, type TabType } from '../App';

/** Temporary adapter: keep domain forms, mutation protocols and task privacy
 * intact. Only replace tab navigation and the redundant legacy header. */
export default function CompatibilityPage({ page }: { page: TabType }) {
  const navigate = useNavigate();
  return (
    <App
      page={page}
      onNavigate={(tab) => {
        void navigate(tab === 'overview' ? '/' : `/${tab}`);
      }}
    />
  );
}
