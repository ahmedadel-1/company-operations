'use client';

import { useParams } from 'next/navigation';

import { ErrorState, Forbidden, ListSkeleton } from '../../../../../components/states';
import { TicketDetail } from '../../../../../components/ticket-detail';
import { useCan } from '../../../../../lib/session';
import { useTicket } from '../../../../../lib/support';

export default function TicketPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const ticket = useTicket(id);
  if (!can('support.view')) {
    return <Forbidden />;
  }
  if (ticket.isPending) {
    return <ListSkeleton rows={6} />;
  }
  if (ticket.isError) {
    return (
      <ErrorState
        error={ticket.error}
        onRetry={() => {
          void ticket.refetch();
        }}
      />
    );
  }
  return <TicketDetail ticket={ticket.data} />;
}
