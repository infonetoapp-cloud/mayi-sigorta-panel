import { OperationalDashboard } from './dashboard/OperationalDashboard';

export default function OverviewPage({ owner }: { owner: boolean }) {
  return <OperationalDashboard owner={owner} />;
}
