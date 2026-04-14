import { EC2Client, StopInstancesCommand } from "@aws-sdk/client-ec2";

const ec2 = new EC2Client({});
const instanceId = process.env.INSTANCE_ID!;

// Invoked by SNS when the CloudWatch idle alarm fires.
// Stops the Metabase EC2 instance. Stopping an already-stopped instance is a no-op.
export const handler = async (): Promise<void> => {
  console.log(`Stopping Metabase instance ${instanceId}`);
  await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
  console.log("Stop command sent");
};
