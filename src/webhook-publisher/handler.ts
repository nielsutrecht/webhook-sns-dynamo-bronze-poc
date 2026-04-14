import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import type { Transaction } from "../shared/types.js";

const sns = new SNSClient({});
const topicArn = process.env.TOPIC_ARN;

export const handler = async (event: unknown): Promise<void> => {
  if (!topicArn) {
    throw new Error("TOPIC_ARN environment variable is not set");
  }

  const transaction = event as Transaction;

  if (!transaction.transactionId) {
    throw new Error("Invalid payload: missing transactionId");
  }

  await sns.send(
    new PublishCommand({
      TopicArn: topicArn,
      Message: JSON.stringify(transaction),
    })
  );
};
