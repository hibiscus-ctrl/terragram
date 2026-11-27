# Who may do what in the orders project.

resource "google_project_iam_member" "api_cloudsql" {
  project = google_project.app.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.api.email}"
}

resource "google_project_iam_member" "worker_logs" {
  project = google_project.app.project_id
  role    = "roles/logging.logWriter"
  member  = google_service_account.worker.member
}

resource "google_project_iam_binding" "viewers" {
  project = google_project.app.project_id
  role    = "roles/viewer"

  members = [
    "group:engineering@example.com",
    "user:alice@example.com",
  ]
}

resource "google_project_iam_member" "oncall" {
  project = google_project.app.project_id
  role    = "roles/owner"
  member  = "user:oncall@example.com"

  condition {
    title      = "until the migration is done"
    expression = "request.time < timestamp(\"2027-01-01T00:00:00Z\")"
  }
}

resource "google_storage_bucket_iam_member" "uploads_api" {
  bucket = google_storage_bucket.uploads.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.api.email}"
}

resource "google_storage_bucket_iam_member" "uploads_worker" {
  bucket = google_storage_bucket.uploads.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.worker.email}"
}

resource "google_storage_bucket_iam_member" "site_public" {
  bucket = google_storage_bucket.site.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

resource "google_pubsub_topic_iam_member" "events_api" {
  topic  = google_pubsub_topic.events.name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_service_account.api.email}"
}

resource "google_pubsub_subscription_iam_member" "events_worker" {
  subscription = google_pubsub_subscription.events.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.worker.email}"
}

resource "google_secret_manager_secret_iam_member" "session_api" {
  secret_id = google_secret_manager_secret.session.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}

resource "google_kms_crypto_key_iam_member" "data_worker" {
  crypto_key_id = google_kms_crypto_key.data.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_service_account.worker.email}"
}

resource "google_bigquery_dataset_iam_member" "analytics_worker" {
  dataset_id = google_bigquery_dataset.analytics.dataset_id
  role       = "roles/bigquery.dataEditor"
  member     = "serviceAccount:${google_service_account.worker.email}"
}

resource "google_service_account_iam_member" "api_acts_as_worker" {
  service_account_id = google_service_account.worker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.api.email}"
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.api.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloudfunctions2_function_iam_member" "worker_invokes" {
  cloud_function = google_cloudfunctions2_function.resize.name
  location       = var.region
  role           = "roles/cloudfunctions.invoker"
  member         = "serviceAccount:${google_service_account.worker.email}"
}
