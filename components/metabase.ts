import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { stackName } from "../config";
import { lambdaRole, lambdaCode } from "../utils";

interface MetabaseArgs {
  developerCidr: string;
  silverBucket: aws.s3.Bucket;
  goldBucket: aws.s3.Bucket;
  athenaResultsBucket: aws.s3.Bucket;
}

export class MetabaseComponent extends pulumi.ComponentResource {
  readonly instanceId: pulumi.Output<string>;

  constructor(name: string, args: MetabaseArgs, opts?: pulumi.ComponentResourceOptions) {
    super("sns-bronze-poc:components:Metabase", name, {}, opts);
    const parent = { parent: this };

    // EC2 IAM role for Metabase (Athena + Glue + S3 access)
    const metabaseEc2Role = new aws.iam.Role("metabase-ec2-role", {
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "ec2.amazonaws.com" }),
      inlinePolicies: [
        {
          name: "athena",
          policy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: [
                  "athena:ListDataCatalogs",
                  "athena:GetDataCatalog",
                  "athena:ListDatabases",
                  "athena:GetDatabase",
                  "athena:ListTableMetadata",
                  "athena:GetTableMetadata",
                  "athena:StartQueryExecution",
                  "athena:GetQueryExecution",
                  "athena:GetQueryResults",
                  "athena:GetWorkGroup",
                  "athena:ListQueryExecutions",
                  "athena:StopQueryExecution",
                  "athena:CreatePreparedStatement",
                  "athena:GetPreparedStatement",
                  "athena:DeletePreparedStatement",
                  "athena:ListPreparedStatements",
                ],
                Resource: "*",
              },
            ],
          }),
        },
        {
          name: "glue",
          policy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: [
                  "glue:GetDatabase",
                  "glue:GetDatabases",
                  "glue:GetTable",
                  "glue:GetTables",
                  "glue:GetPartition",
                  "glue:GetPartitions",
                  "glue:BatchGetPartition",
                ],
                Resource: "*",
              },
            ],
          }),
        },
        {
          name: "s3",
          policy: pulumi.jsonStringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: ["s3:GetBucketLocation", "s3:GetObject", "s3:ListBucket"],
                Resource: [
                  args.silverBucket.arn, pulumi.interpolate`${args.silverBucket.arn}/*`,
                  args.goldBucket.arn, pulumi.interpolate`${args.goldBucket.arn}/*`,
                ],
              },
              {
                Effect: "Allow",
                Action: [
                  "s3:GetBucketLocation", "s3:GetObject", "s3:PutObject", "s3:ListBucket",
                  "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts",
                ],
                Resource: [args.athenaResultsBucket.arn, pulumi.interpolate`${args.athenaResultsBucket.arn}/*`],
              },
            ],
          }),
        },
      ],
    }, parent);

    const metabaseInstanceProfile = new aws.iam.InstanceProfile("metabase-instance-profile", {
      role: metabaseEc2Role.name,
    }, parent);

    // Security group — ingress port 3000, all egress
    const metabaseSecurityGroup = new aws.ec2.SecurityGroup("metabase-sg", {
      name: pulumi.interpolate`metabase-${stackName}`,
      description: "Metabase - ingress port 3000, all egress",
      ingress: [
        {
          protocol: "tcp",
          fromPort: 3000,
          toPort: 3000,
          cidrBlocks: [args.developerCidr],
          description: "Metabase UI",
        },
      ],
      egress: [
        { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
      ],
      tags: { Name: pulumi.interpolate`metabase-${stackName}` },
    }, parent);

    const firstAz = aws.getAvailabilityZonesOutput({ state: "available" }).apply(azs => azs.names[0]);

    const metabaseAmi = aws.ec2.getAmiOutput({
      owners: ["amazon"],
      mostRecent: true,
      filters: [{ name: "name", values: ["al2023-ami-*-x86_64"] }],
    });

    // User-data: runs on first boot. Mounts EBS, installs Java, downloads Metabase JAR, sets up systemd.
    // Subsequent starts: EBS is already mounted via fstab; systemd auto-starts metabase.service.
    const metabaseUserData = `#!/bin/bash
set -euo pipefail

MOUNTPOINT="/metabase-data"

# On AL2023 t3 instances: root=nvme0n1, first additional EBS=nvme1n1 (/dev/sdf alias)
DEVICE="/dev/nvme1n1"

# Format only if the volume has no filesystem
if ! blkid "$DEVICE" &>/dev/null; then
  mkfs.ext4 "$DEVICE"
fi

mkdir -p "$MOUNTPOINT"
mount "$DEVICE" "$MOUNTPOINT"

# Persist mount across reboots
FSTAB_ENTRY="$DEVICE $MOUNTPOINT ext4 defaults,nofail 0 2"
grep -qF "$FSTAB_ENTRY" /etc/fstab || echo "$FSTAB_ENTRY" >> /etc/fstab

# Install Java 17 (Amazon Corretto)
dnf install -y java-17-amazon-corretto-headless

# Download Metabase JAR (skip if already present on the persistent volume)
MB_VERSION="v0.52.5"
MB_JAR="$MOUNTPOINT/metabase.jar"
if [ ! -f "$MB_JAR" ]; then
  curl -fsSL "https://downloads.metabase.com/$MB_VERSION/metabase.jar" -o "$MB_JAR"
fi

# Create metabase system user
id -u metabase &>/dev/null || useradd -r -s /bin/false -d "$MOUNTPOINT" metabase
chown -R metabase:metabase "$MOUNTPOINT"

# Write systemd unit
cat > /etc/systemd/system/metabase.service << 'SERVICE'
[Unit]
Description=Metabase
After=network.target

[Service]
Type=simple
User=metabase
Environment=MB_DB_FILE=/metabase-data/metabase.db
Environment=MB_PLUGINS_DIR=/metabase-data/plugins
WorkingDirectory=/metabase-data
ExecStart=/usr/bin/java -jar /metabase-data/metabase.jar
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable metabase
systemctl start metabase
`;

    // EC2 instance with inline EBS (deleteOnTermination=false — volume survives instance termination)
    const metabaseInstance = new aws.ec2.Instance("metabase", {
      ami: metabaseAmi.id,
      instanceType: "t3.small",
      iamInstanceProfile: metabaseInstanceProfile.name,
      vpcSecurityGroupIds: [metabaseSecurityGroup.id],
      availabilityZone: firstAz,
      userData: metabaseUserData,
      ebsBlockDevices: [
        {
          deviceName: "/dev/sdf",
          volumeSize: 8,
          volumeType: "gp3",
          deleteOnTermination: false,
        },
      ],
      tags: { Name: pulumi.interpolate`metabase-${stackName}` },
    }, parent);

    this.instanceId = metabaseInstance.id;

    // Auto-stop Lambda role
    const metabaseStopRole = lambdaRole("metabase-stop", [
      {
        name: "ec2-stop",
        policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["ec2:StopInstances", "ec2:DescribeInstances"],
              Resource: "*",
            },
          ],
        }),
      },
    ]);

    // Auto-stop Lambda
    const metabaseStopLambda = new aws.lambda.Function("metabase-stop", {
      name: pulumi.interpolate`metabase-stop-${stackName}`,
      runtime: aws.lambda.Runtime.NodeJS20dX,
      handler: "index.handler",
      role: metabaseStopRole.arn,
      code: lambdaCode("metabase-stop.js"),
      environment: { variables: { INSTANCE_ID: metabaseInstance.id } },
      timeout: 10,
    }, parent);

    // SNS topic that CloudWatch alarm publishes to
    const metabaseAlarmTopic = new aws.sns.Topic("metabase-alarm-topic", {
      name: pulumi.interpolate`metabase-idle-alarm-${stackName}`,
    }, parent);

    // Wire alarm topic → stop Lambda
    new aws.sns.TopicSubscription("metabase-alarm-sub", {
      topic: metabaseAlarmTopic.arn,
      protocol: "lambda",
      endpoint: metabaseStopLambda.arn,
    }, parent);

    // Allow SNS to invoke the stop Lambda
    new aws.lambda.Permission("metabase-stop-sns-permission", {
      action: "lambda:InvokeFunction",
      function: metabaseStopLambda.name,
      principal: "sns.amazonaws.com",
      sourceArn: metabaseAlarmTopic.arn,
    }, parent);

    // CloudWatch alarm — CPU < 5% for 2 × 5-minute periods → stop instance
    new aws.cloudwatch.MetricAlarm("metabase-idle-alarm", {
      name: pulumi.interpolate`metabase-idle-${stackName}`,
      comparisonOperator: "LessThanThreshold",
      evaluationPeriods: 2,
      metricName: "CPUUtilization",
      namespace: "AWS/EC2",
      period: 300,
      statistic: "Average",
      threshold: 5,
      dimensions: { InstanceId: metabaseInstance.id },
      alarmActions: [metabaseAlarmTopic.arn],
      treatMissingData: "notBreaching",
      alarmDescription: "Stop Metabase EC2 when idle for 10+ minutes",
    }, parent);

    this.registerOutputs({
      instanceId: this.instanceId,
    });
  }
}
