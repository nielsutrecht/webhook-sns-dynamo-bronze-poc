export interface Transaction {
  transactionId: string;
  accountId: string;
  customerId: string | null;
  occurredAt: string;
  settledAt: string | null;
  amountCents: number;
  currency: string;
  balanceAfterCents: number | null;
  balanceCurrency: string;
  description: string;
  transactionType:
    | "TRANSFER"
    | "CASH"
    | "CREDITCARD"
    | "DEBITCARD"
    | "FEES"
    | "INTEREST"
    | "PAYMENT";
  status:
    | "settled"
    | "pending"
    | "booked"
    | "captured"
    | "authorised"
    | "received";
  accountBic: string;
  counterpartyName: string;
  counterpartyIban: string;
  counterpartyBic: string;
  bankReference: string | null;
  eventId: string;
  isInternal: boolean;
}

export interface SnsEnvelope {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
}
