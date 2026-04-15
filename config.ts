import * as pulumi from "@pulumi/pulumi";

export const stackName = pulumi.getStack();

const cfg = new pulumi.Config();
// Set with: pulumi config set developerCidr <your-ip>/32
export const developerCidr = cfg.get("developerCidr") ?? "0.0.0.0/0";
