import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { stackName } from "../config";

export class StorageComponent extends pulumi.ComponentResource {
  readonly bronzeBucket: aws.s3.Bucket;
  readonly silverBucket: aws.s3.Bucket;
  readonly goldBucket: aws.s3.Bucket;
  readonly athenaResultsBucket: aws.s3.Bucket;

  constructor(name: string, opts?: pulumi.ComponentResourceOptions) {
    super("sns-bronze-poc:components:Storage", name, {}, opts);
    const parent = { parent: this };

    this.bronzeBucket = new aws.s3.Bucket("bronze-bucket", {
      bucket: `webhook-bronze-${stackName}`,
      forceDestroy: true,
    }, parent);

    this.silverBucket = new aws.s3.Bucket("silver-bucket", {
      bucket: pulumi.interpolate`webhook-silver-${stackName}`,
      forceDestroy: true,
    }, parent);

    this.goldBucket = new aws.s3.Bucket("gold-bucket", {
      bucket: pulumi.interpolate`webhook-gold-${stackName}`,
      forceDestroy: true,
    }, parent);

    this.athenaResultsBucket = new aws.s3.Bucket("athena-results-bucket", {
      bucket: pulumi.interpolate`webhook-athena-results-${stackName}`,
      forceDestroy: true,
    }, parent);

    this.registerOutputs({
      bronzeBucketName: this.bronzeBucket.bucket,
      silverBucketName: this.silverBucket.bucket,
      goldBucketName: this.goldBucket.bucket,
      athenaResultsBucketName: this.athenaResultsBucket.bucket,
    });
  }
}
