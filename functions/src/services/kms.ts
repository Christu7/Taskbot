/**
 * Low-level KMS encryption/decryption primitives.
 *
 * Run these commands ONCE per Firebase project to create the key ring and key:
 *
 *   gcloud kms keyrings create taskbot --location=global --project=[PROJECT_ID]
 *   gcloud kms keys create secrets --location=global --keyring=taskbot \
 *     --purpose=encryption --project=[PROJECT_ID]
 *
 *   # Then set the env var (functions/.env for local, Firebase config for prod):
 *   # KMS_KEY_NAME=projects/[PROJECT_ID]/locations/global/keyRings/taskbot/cryptoKeys/secrets
 *   npx firebase functions:config:set \
 *     kms.key_name="projects/[PROJECT_ID]/locations/global/keyRings/taskbot/cryptoKeys/secrets"
 *
 * IAM NOTE: Cloud Functions running in the SAME GCP project as the KMS key
 * automatically have permission to use it via the default service account.
 * If the Firebase project and KMS key are in DIFFERENT projects, grant the
 * Cloud Functions service account the "Cloud KMS CryptoKey Encrypter/Decrypter"
 * IAM role on the KMS key (or keyring) in that project:
 *
 *   gcloud kms keys add-iam-policy-binding secrets \
 *     --location=global --keyring=taskbot \
 *     --member=serviceAccount:SERVICE_ACCOUNT_EMAIL \
 *     --role=roles/cloudkms.cryptoKeyEncrypterDecrypter \
 *     --project=[KMS_PROJECT_ID]
 */

import { KeyManagementServiceClient } from "@google-cloud/kms";

const kmsClient = new KeyManagementServiceClient();

// Read once at module load — the only env var needed for the secrets system
const keyName = process.env.KMS_KEY_NAME;

/**
 * Encrypts a plaintext string with the configured KMS key.
 * Returns a base64-encoded ciphertext string suitable for Firestore storage.
 */
export async function encrypt(plaintext: string): Promise<string> {
  if (!keyName) throw new Error("KMS_KEY_NAME not configured");
  const [result] = await kmsClient.encrypt({
    name: keyName,
    plaintext: Buffer.from(plaintext),
  });
  return Buffer.from(result.ciphertext as Uint8Array).toString("base64");
}

/**
 * Decrypts a base64-encoded ciphertext string produced by encrypt().
 * Returns the original plaintext.
 */
export async function decrypt(ciphertext: string): Promise<string> {
  if (!keyName) throw new Error("KMS_KEY_NAME not configured");
  const [result] = await kmsClient.decrypt({
    name: keyName,
    ciphertext: Buffer.from(ciphertext, "base64"),
  });
  return Buffer.from(result.plaintext as Uint8Array).toString("utf8");
}
