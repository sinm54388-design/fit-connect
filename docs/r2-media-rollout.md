# FIT-CONNECT R2 rollout

Create private Standard R2 buckets for production and preview. Add the production bucket as the Worker binding `FIT_MEDIA` in Wrangler configuration, and use a separate bucket for preview. Configure the same existing member session signing secret in the preview environment. Both public bucket access options should stay disabled. With the binding absent, the Worker creates new uploads in the existing Supabase bucket.

## Copy existing objects

Configure read-only Supabase S3 access and R2 object write access outside the repository. Configure each as an S3-compatible rclone remote named `supabase` and `cloudflare`. The examples use `fit-connect-media` as the destination. Run the dry run and check the reported scope before copying. With those remotes the buckets are addressed by name.

```sh
for bucket in fit-direct-videos fit-private-videos; do
  rclone copy --dry-run --immutable --metadata "supabase:$bucket" "cloudflare:fit-connect-media/r2/$bucket" || exit 1
done
```

```sh
for bucket in fit-direct-videos fit-private-videos; do
  rclone copy --immutable --metadata "supabase:$bucket" "cloudflare:fit-connect-media/r2/$bucket" || exit 1
  rclone check --download --one-way "supabase:$bucket" "cloudflare:fit-connect-media/r2/$bucket" || exit 1
done
```

Keep the Supabase originals through validation. Existing row references and member links work with a verified copy at the destination path. The Worker serves existing videos from Supabase when a copy is absent. Repeat the copy after the production switch to pick up uploads that started before activation.

## Verify the preview and production

Run `node --experimental-vm-modules scripts/smoke-check.cjs`. On a test member account, upload a video above 6 MiB, interrupt the connection, resume, play, and seek. Confirm a small video or meal photo also uploads. Verify an existing video from each storage bucket still plays, that switching members denies playback for the other member's video reference, and that saving PT and meal entries works. Check that the bucket contains the test uploads. Apply the production binding after these checks and repeat those checks on the approved production test account.

If a problem occurs after R2 accepts production uploads, keep the binding available for R2-backed records while the issue is resolved. Removing the binding or deploying older code will make those newly backed records unavailable. Quota and current storage usage are visible on the Cloudflare R2 dashboard.
