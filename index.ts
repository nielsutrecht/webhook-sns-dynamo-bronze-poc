import { developerCidr } from "./config";
import { StorageComponent } from "./components/storage";
import { IngestionComponent } from "./components/ingestion";
import { DynamoSinkComponent } from "./components/dynamo-sink";
import { AnalyticsComponent } from "./components/analytics";
import { MetabaseComponent } from "./components/metabase";

const storage = new StorageComponent("storage");

const ingestion = new IngestionComponent("ingestion", {
  bronzeBucket: storage.bronzeBucket,
});

new DynamoSinkComponent("dynamo-sink", {
  topic: ingestion.topic,
});

const analytics = new AnalyticsComponent("analytics", {
  bronzeBucket: storage.bronzeBucket,
  silverBucket: storage.silverBucket,
  goldBucket: storage.goldBucket,
  athenaResultsBucket: storage.athenaResultsBucket,
});

const metabase = new MetabaseComponent("metabase", {
  developerCidr,
  silverBucket: storage.silverBucket,
  goldBucket: storage.goldBucket,
  athenaResultsBucket: storage.athenaResultsBucket,
});

export const bronzeBucketName      = storage.bronzeBucket.bucket;
export const silverBucketName      = storage.silverBucket.bucket;
export const goldBucketName        = storage.goldBucket.bucket;
export const athenaResultsBucketName = storage.athenaResultsBucket.bucket;
export const topicArn              = ingestion.topic.arn;
export const firehoseStreamName    = ingestion.firehoseStream.name;
export const glueDatabaseName      = analytics.glueDatabase.name;
export const athenaWorkgroupName   = analytics.athenaWorkgroup.name;
export const silverTriggerQueueUrl = analytics.silverTriggerQueue.url;
export const metabaseInstanceId    = metabase.instanceId;
