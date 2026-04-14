import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { SQSEvent } from "aws-lambda";
import type { SnsEnvelope, Transaction } from "../shared/types.js";

const client = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(client);
const tableName = process.env.TABLE_NAME;

export const handler = async (event: SQSEvent): Promise<void> => {
  if (!tableName) {
    throw new Error("TABLE_NAME environment variable is not set");
  }

  for (const record of event.Records) {
    const envelope = JSON.parse(record.body) as SnsEnvelope;
    const transaction = JSON.parse(envelope.Message) as Transaction;

    await dynamo.send(
      new PutCommand({
        TableName: tableName,
        Item: transaction,
      })
    );
  }
};
