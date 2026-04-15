import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as path from "path";

export function lambdaRole(name: string, inlinePolicies: aws.iam.RoleArgs["inlinePolicies"] = []): aws.iam.Role {
  return new aws.iam.Role(`${name}-role`, {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "lambda.amazonaws.com" }),
    managedPolicyArns: [aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole],
    inlinePolicies,
  });
}

export function lambdaCode(distFile: string): pulumi.asset.AssetArchive {
  return new pulumi.asset.AssetArchive({
    "index.js": new pulumi.asset.FileAsset(path.join("dist", distFile)),
  });
}
