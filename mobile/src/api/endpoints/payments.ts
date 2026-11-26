import client from '../client';
import type { Ticket } from '../../domain/types';
import type { CloseBody } from '../../features/waiter/pay/payModel';

export interface ClosedTicket extends Ticket {
  change_due?: number;
}

/**
 * POST /tickets/:id/close. `idempotencyKey` is generated once per pay attempt (payAttemptStore) so a retry replays.
 * Already CLOSED -> 200 with the ticket. Errors: 422 INSUFFICIENT_PAYMENT|AMOUNT_MISMATCH, 409 TICKET_NOT_OPEN|VERSION_CONFLICT,
 * 403 PIN_REQUIRED (resend with `manager_pin`) | BAR_CLOSED.
 */
export async function closeTicket(ticketId: string, body: CloseBody, idempotencyKey: string): Promise<ClosedTicket> {
  const { data } = await client.post<ClosedTicket>(`/tickets/${ticketId}/close`, body, { headers: { 'Idempotency-Key': idempotencyKey } });
  return data;
}

/** Final receipt print (best-effort). 503 when the print agent is down. */
export async function printReceipt(ticketId: string): Promise<{ ok: boolean; job_id?: string }> {
  const { data } = await client.post<{ ok: boolean; job_id?: string }>(`/tickets/${ticketId}/print`, {}, { params: { unpaid: false } });
  return data;
}
