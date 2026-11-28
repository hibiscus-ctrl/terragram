#!/usr/bin/env bash
# Copyright 2026 Gabriel Ignat
# SPDX-License-Identifier: AGPL-3.0-only

# The steps of the Google Cloud sandbox workflow (.github/workflows/sandbox-google.yml), one command
# each, so a step reads as what it does and the workflow stays short:
#
#   sandbox-gcp.sh generate              write the four plans (scripts/sandbox-gcp-plans.ts); needs no credentials
#   sandbox-gcp.sh summary               print, as Markdown, what the plans change for a sandbox project; needs none
#   sandbox-gcp.sh validate              refuse plans that are not what the generator writes (sandbox-gcp-validate.mjs); needs none
#   sandbox-gcp.sh preflight             fail if a service account holds Editor, Owner or a role that can mint or widen access in the project
#   sandbox-gcp.sh apply <plan>          terraform init and apply one plan
#   sandbox-gcp.sh smoke <plan>          check the plan's main resources exist and are healthy
#   sandbox-gcp.sh destroy <plan>        terraform destroy it, tried again, and fail if state is left
#   sandbox-gcp.sh sweep                 delete every resource named like a run's own (ih-sbx-tg-<plan letter><4 hex digits>), whatever made it
#
# <plan> is gcp-data, gcp-platform, gcp-site or gcp-serverless. Everything a run creates is named
# ih-sbx-tg-<plan letter><four hex digits of the run> and labelled terragram_sandbox=<run id>, so the
# sweep finds it by that exact shape of name, never by the prefix alone (networks, firewall rules, routers and service accounts take no labels) and a
# reader finds whose it is by label. Terraform's state stays in the runner's temporary directory: it is
# never printed, uploaded or kept, and no command here prints an output or an attribute value.
#
# The job that signs in runs Terraform on plans another job wrote, so before it does: `validate` refuses
# anything but the generator's own shapes, `terraform init` takes its providers only from the committed lock
# file (-lockfile=readonly, from the registry, no plugin cache), and the CLI configuration is the committed
# sandbox-gcp.tfrc, whatever the runner has.
#
# Environment: SANDBOX_DIR (where the plans are written, by default under RUNNER_TEMP), GOOGLE_PROJECT_ID, GOOGLE_REGION (default
# europe-west2), GITHUB_RUN_ID (and GITHUB_RUN_ATTEMPT), and the credentials file the step signs in
# with (GOOGLE_APPLICATION_CREDENTIALS, CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE).
set -euo pipefail

command=${1:?usage: sandbox-gcp.sh generate|summary|validate|preflight|apply|smoke|destroy|sweep [plan]}
plan=${2:-}
work=${SANDBOX_DIR:-${RUNNER_TEMP:?}/sandbox-gcp}
region=${GOOGLE_REGION:-europe-west2}
zone="${region}-a"
mark="ih-sbx-tg-"
# One run's names as a pattern: the prefix (prefix) is the mark, a plan's letter and four hex digits; the shared network's
# (network_name) is the mark, "net-" and four hex digits. A name has it at its start or after a hyphen or a slash, and ends
# with it or goes on after a hyphen, so something that only has ih-sbx-tg- somewhere in its name (another team's
# ih-sbx-tg-notes, a bucket called prod-ih-sbx-tg) is never the sweep's. The sweep takes every run's leftovers, so the
# run id is not part of it. name_re is for gcloud's --filter and jq, dataset_re for BigQuery's ids (no hyphens).
run_re="${mark}([dpsf]|net-)[0-9a-f]{4}"
name_re="(^|[-/])${run_re}(-|\$)"
dataset_re='(^|_)ih_sbx_tg_([dpsf]|net_)[0-9a-f]{4}(_|$)'
here=$(cd "$(dirname "$0")" && pwd)

# Generating and summarising run where no token can be had (the first job installs dependencies), and
# validating runs before the second job signs in, so they need no project and no credentials; everything
# else needs both.
project=
case $command in
  generate | summary | validate) ;;
  *)
    project=${GOOGLE_PROJECT_ID:?}
    export CLOUDSDK_CORE_PROJECT=$project
    export GOOGLE_APPLICATION_CREDENTIALS=${GOOGLE_APPLICATION_CREDENTIALS:?}
    export CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE=$GOOGLE_APPLICATION_CREDENTIALS
    ;;
esac
mkdir -p "$work"
# Nothing of Terraform's environment but what is set here: no plugin cache, no reattached or overridden
# providers, no data directory, no variables, no extra arguments.
while IFS= read -r name; do unset "$name"; done < <(compgen -e | grep -E '^(TF_|TERRAFORM_)' || true)
export TF_CLI_CONFIG_FILE=$here/sandbox-gcp.tfrc
export TF_IN_AUTOMATION=1
export TF_INPUT=0
export TF_CLI_ARGS="-no-color"
q=(--quiet)

fail() {
  echo "::error::$*"
  exit 1
}

letter() {
  case $1 in
    gcp-data) echo d ;;
    gcp-platform) echo p ;;
    gcp-site) echo s ;;
    gcp-serverless) echo f ;;
    *) fail "unknown plan '$1'" ;;
  esac
}

# Four hex digits of the run, so a run's names differ from the last run's: a KMS key ring can't be
# deleted, so its name can't be used again.
prefix() {
  local digest
  digest=$(printf '%s-%s' "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:-1}" | sha256sum)
  echo "${mark}$(letter "$1")${digest:0:4}"
}

# listed runs a gcloud list command and prints what it lists. A project where a service's API isn't
# enabled holds none of its resources, so that failure lists nothing; any other failure stops the sweep.
listed() {
  local out err
  err=$(mktemp)
  if out=$(gcloud "$@" 2>"$err"); then
    rm -f "$err"
    printf '%s\n' "$out"
    return
  fi
  if grep -qE 'SERVICE_DISABLED|has not been used in project|API .* is not enabled' "$err"; then
    rm -f "$err"
    return 0
  fi
  cat "$err" >&2
  rm -f "$err"
  return 1
}

retry() {
  local attempt
  for attempt in 1 2 3; do
    "$@" && return 0
    echo "::warning::'$1 $2' failed (attempt $attempt)"
    sleep 20
  done
  return 1
}

# tf_init <dir> <plan or network>: terraform init with the committed lock file of that root (sandbox-gcp-locks/,
# one per root, since a lock file naming a provider the root does not use counts as a change) copied in and
# read-only, so a provider that is not in it, or whose package does not match its hashes, fails the init
# instead of being installed.
tf_init() {
  cp "$here/sandbox-gcp-locks/$2.terraform.lock.hcl" "$1/.terraform.lock.hcl"
  (cd "$1" && terraform init -input=false -lockfile=readonly)
}

write_vars() {
  local dir=$1 id=$2 extra=$3
  jq -n --arg project "$project" --arg region "$region" --arg prefix "$(prefix "$id")" --arg run "${GITHUB_RUN_ID:?}" --argjson extra "$extra" \
    '{project_id: $project, region: $region, name_prefix: $prefix, labels: {terragram_sandbox: $run}} + $extra' > "$dir/sandbox.auto.tfvars.json"
}

network_name() {
  echo "${mark}net-$(prefix gcp-data | tail -c 5)"
}

apply_network() {
  local dir=$work/network
  rm -rf "$dir"
  cp -r "$here/sandbox-gcp-network" "$dir"
  (
    cd "$dir"
    retry tf_init "$dir" network
    terraform apply -auto-approve -input=false -lock-timeout=5m \
      -var "project_id=$project" -var "region=$region" -var "name=$(network_name)"
  )
}

destroy_network() {
  local dir=$work/network
  [ -f "$dir/terraform.tfstate" ] || return 0
  # What Cloud SQL and Memorystore peered with the network stays until their instances are gone for good:
  # the peering is deleted by name, tried again, before the network goes.
  local attempt
  for attempt in 1 2 3 4 5; do
    gcloud services vpc-peerings delete --network "$(network_name)" --service servicenetworking.googleapis.com "${q[@]}" 2>/dev/null && break
    sleep 60
  done
  (
    cd "$dir"
    for attempt in 1 2 3; do
      terraform destroy -auto-approve -input=false -lock-timeout=5m \
        -var "project_id=$project" -var "region=$region" -var "name=$(network_name)" && exit 0
      echo "::warning::destroying the network failed (attempt $attempt)"
      sleep 60
    done
    exit 1
  )
}

apply_plan() {
  local id=$1 dir=$work/$1
  [ -f "$dir/main.tf" ] || fail "$id was not generated"
  case $id in
    gcp-data)
      apply_network
      local net
      net=$(cd "$work/network" && terraform output -json)
      write_vars "$dir" "$id" "$(jq -c '{alert_email: "terragram-sandbox@example.com", network_id: .network_id.value, subnetwork_id: .subnetwork_id.value}' <<< "$net")"
      ;;
    gcp-platform)
      # TEST-NET-1: a /24 nothing is reached from, which the control plane's authorised network must be.
      write_vars "$dir" "$id" '{gke_authorized_cidr: "192.0.2.0/24"}'
      ;;
    gcp-serverless)
      write_vars "$dir" "$id" '{alert_email: "terragram-sandbox@example.com"}'
      ;;
    *)
      write_vars "$dir" "$id" '{}'
      ;;
  esac
  (
    cd "$dir"
    retry tf_init "$dir" "$id"
    terraform validate
    terraform apply -auto-approve -input=false -lock-timeout=5m -parallelism=10
  )
}

# check <what> <expected> <actual>
check() {
  if [ "$3" != "$2" ]; then
    echo "::error::smoke check failed: $1 (expected '$2', found '$3')"
    smoke_failed=1
  else
    echo "ok: $1"
  fi
}

count() {
  grep -c . <<< "$1" || true
}

smoke_plan() {
  local id=$1 p dir=$work/$1
  p=$(prefix "$id")
  smoke_failed=0
  case $id in
    gcp-serverless)
      check "the Cloud Run service is ready" 1 "$(listed run services list --region "$region" --filter "metadata.name ~ $p" --format json |
        jq '[.[] | select(.status.conditions[]? | select(.type == "Ready" and .status == "True"))] | length')"
      check "the function is active" ACTIVE "$(listed functions describe "fn-$p-functions" --gen2 --region "$region" --format 'value(state)')"
      check "the Pub/Sub topics exist" 2 "$(count "$(listed pubsub topics list --filter "name ~ $p" --format 'value(name)')")"
      ;;
    gcp-site)
      check "the DNS zone exists" "zone-$p-dns" "$(listed dns managed-zones list --filter "name ~ $p" --format 'value(name)')"
      check "the backend bucket exists" 1 "$(count "$(listed compute backend-buckets list --filter "name ~ $p" --format 'value(name)')")"
      check "the buckets exist" 4 "$(count "$(listed storage buckets list --filter "name ~ $p" --format 'value(name)')")"
      ;;
    gcp-platform)
      check "the GKE cluster is running" RUNNING "$(listed container clusters describe "gke-$p-kubernetes" --location "$zone" --format 'value(status)')"
      check "the virtual machine is running" RUNNING "$(listed compute instances describe "vm-$p-virtual-machine" --zone "$zone" --format 'value(status)')"
      ;;
    gcp-data)
      check "the Cloud SQL instances are runnable" "RUNNABLE
RUNNABLE" "$(listed sql instances list --filter "name ~ $p" --format 'value(state)')"
      check "the Memorystore instance is ready" READY "$(listed redis instances list --region "$region" --filter "name ~ $p" --format 'value(state)')"
      check "the Firestore database exists" 1 "$(count "$(listed firestore databases list --filter "name ~ $p" --format 'value(name)')")"
      check "the BigQuery dataset exists" 1 "$(count "$(bq_datasets "$(printf '%s' "$p" | tr - _)")")"
      ;;
    *) fail "unknown plan '$id'" ;;
  esac
  # A second plan finds nothing to change, or says so: it is a warning, since a provider may leave a
  # difference no one can set away, but never a failure to apply.
  local code=0
  (cd "$dir" && terraform plan -detailed-exitcode -input=false -lock-timeout=5m > /dev/null 2>&1) || code=$?
  case $code in
    0) echo "ok: planning again finds no change" ;;
    2) echo "::warning::planning $id again finds changes to make (the plan is not idempotent here)" ;;
    *) echo "::error::planning $id again failed"; smoke_failed=1 ;;
  esac
  [ "$smoke_failed" -eq 0 ]
}

bigquery="https://bigquery.googleapis.com/bigquery/v2/projects/$project/datasets"

# bq_datasets <pattern>: the project's datasets whose ID matches the extended regular expression (dataset IDs take no hyphens).
bq_datasets() {
  local token
  token=$(gcloud auth print-access-token)
  curl -fsS -H "Authorization: Bearer $token" "$bigquery?all=true&maxResults=1000" |
    jq -r '.datasets[]?.datasetReference.datasetId' | grep -E "$1" || true
}

destroy_state() {
  local id=$1 dir=$work/$1 attempt left
  cd "$dir"
  retry tf_init "$dir" "$id" || return 1
  # A destroy that fails, as on a dependency Google Cloud still deletes (a private service connection
  # waits for the databases to be gone), is tried twice more before what is left counts.
  for attempt in 1 2 3; do
    terraform destroy -auto-approve -input=false -lock-timeout=5m -parallelism=10 && break
    echo "::warning::destroy of $id failed (attempt $attempt)"
    sleep 120
  done
  left=$(terraform state list) || return 1
  if [ -n "$left" ]; then
    echo "::error::Left in $id's state: $left"
    return 1
  fi
}

destroy_plan() {
  local id=$1 dir=$work/$1 failed=0
  if [ -f "$dir/terraform.tfstate" ]; then
    (destroy_state "$id") || failed=1
  else
    echo "$id has no state: nothing was created."
  fi
  if [ "$id" = gcp-data ]; then
    destroy_network || failed=1
  fi
  [ "$failed" -eq 0 ]
}

# Every resource named like a run's own (name_re), by kind, those that use others first. The plans' names
# put the kind first (waf-ih-sbx-tg-d1a2b-..., cdn-ih-sbx-tg-d1a2b-...), so the pattern may start after a hyphen.
sweep_all() {
  local named="name ~ \"$name_re\"" token rest name loc kind
  token=$(gcloud auth print-access-token)
  names=$(listed run services list --region "$region" --filter "metadata.name ~ \"$name_re\"" --format 'value(metadata.name)')
  while IFS= read -r name; do [ -n "$name" ] && gcloud run services delete "$name" --region "$region" "${q[@]}" || true; done <<< "$names"
  names=$(listed functions list --filter "name ~ \"/functions/(.*-)?${run_re}(-|\$)\"" --format 'value(name.basename(),name.segment(3))')
  while read -r name loc; do [ -n "$name" ] && gcloud functions delete "$name" --region "$loc" "${q[@]}" || true; done <<< "$names"
  names=$(listed container clusters list --filter "$named" --format 'value(name,location)')
  while read -r name loc; do [ -n "$name" ] && gcloud container clusters delete "$name" --location "$loc" "${q[@]}" || true; done <<< "$names"
  # The load balancers, from the forwarding rules to the backends and the addresses.
  for kind in forwarding-rules target-http-proxies target-https-proxies url-maps backend-services; do
    names=$(listed compute "$kind" list --global --filter "$named" --format 'value(name)')
    while IFS= read -r name; do [ -n "$name" ] && gcloud compute "$kind" delete "$name" --global "${q[@]}" || true; done <<< "$names"
  done
  for kind in backend-buckets ssl-certificates ssl-policies security-policies; do
    names=$(listed compute "$kind" list --filter "$named" --format 'value(name)')
    while IFS= read -r name; do [ -n "$name" ] && gcloud compute "$kind" delete "$name" "${q[@]}" || true; done <<< "$names"
  done
  names=$(listed compute network-endpoint-groups list --filter "$named" --format 'value(name,region.basename())')
  while read -r name loc; do [ -n "$name" ] && [ -n "$loc" ] && gcloud compute network-endpoint-groups delete "$name" --region "$loc" "${q[@]}" || true; done <<< "$names"
  names=$(listed compute instances list --filter "$named" --format 'value(name,zone.basename())')
  while read -r name loc; do [ -n "$name" ] && gcloud compute instances delete "$name" --zone "$loc" "${q[@]}" || true; done <<< "$names"
  names=$(listed redis instances list --region "$region" --filter "$named" --format 'value(name.basename())')
  while IFS= read -r name; do [ -n "$name" ] && gcloud redis instances delete "$name" --region "$region" "${q[@]}" || true; done <<< "$names"
  names=$(listed sql instances list --filter "$named" --format 'value(name)')
  while IFS= read -r name; do
    # Deletion protection is on for an instance made outside a sandbox plan: this one is ours by name.
    [ -n "$name" ] && { gcloud sql instances patch "$name" --no-deletion-protection "${q[@]}" || true; gcloud sql instances delete "$name" "${q[@]}" || true; }
  done <<< "$names"
  for name in $(bq_datasets "$dataset_re"); do
    curl -fsS -X DELETE -H "Authorization: Bearer $token" "$bigquery/$name?deleteContents=true" || true
  done
  names=$(listed firestore databases list --filter "$named" --format 'value(name.basename())')
  while IFS= read -r name; do [ -n "$name" ] && gcloud firestore databases delete --database "$name" "${q[@]}" || true; done <<< "$names"
  names=$(listed secrets list --filter "$named" --format 'value(name.basename())')
  while IFS= read -r name; do [ -n "$name" ] && gcloud secrets delete "$name" "${q[@]}" || true; done <<< "$names"
  for kind in subscriptions topics; do
    names=$(listed pubsub "$kind" list --filter "$named" --format 'value(name.basename())')
    while IFS= read -r name; do [ -n "$name" ] && gcloud pubsub "$kind" delete "$name" "${q[@]}" || true; done <<< "$names"
  done
  names=$(listed dns managed-zones list --filter "$named" --format 'value(name)')
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    rest=$(listed dns record-sets list --zone "$name" --filter 'type != SOA AND type != NS' --format 'csv[no-heading](name,type)')
    while IFS=, read -r loc kind; do [ -n "$loc" ] && gcloud dns record-sets delete "$loc" --type "$kind" --zone "$name" "${q[@]}" || true; done <<< "$rest"
    gcloud dns managed-zones delete "$name" "${q[@]}" || true
  done <<< "$names"
  names=$(listed storage buckets list --filter "$named" --format 'value(name)')
  while IFS= read -r name; do [ -n "$name" ] && gcloud storage rm --recursive "gs://$name" "${q[@]}" || true; done <<< "$names"
  # Monitoring has no gcloud group outside alpha: the REST API, with gcloud's token.
  for kind in alertPolicies notificationChannels; do
    names=$(curl -fsS -H "Authorization: Bearer $token" "https://monitoring.googleapis.com/v3/projects/$project/$kind" |
      jq -r --arg re "$name_re" '(.alertPolicies // .notificationChannels // [])[] | select(.displayName | test($re)) | .name')
    while IFS= read -r name; do [ -n "$name" ] && curl -fsS -X DELETE -H "Authorization: Bearer $token" "https://monitoring.googleapis.com/v3/$name" || true; done <<< "$names"
  done
  # Key rings and keys can't be deleted: only the versions of keys still enabled or disabled are destroyed.
  names=$(listed kms keyrings list --location "$region" --filter "$named" --format 'value(name)')
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    for loc in $(listed kms keys list --keyring "$name" --format 'value(name)'); do
      for rest in $(listed kms keys versions list --key "$loc" --filter 'state=ENABLED OR state=DISABLED' --format 'value(name)'); do
        gcloud kms keys versions destroy "$rest" "${q[@]}" || true
      done
    done
  done <<< "$names"
  names=$(listed compute firewall-rules list --filter "$named" --format 'value(name)')
  while IFS= read -r name; do [ -n "$name" ] && gcloud compute firewall-rules delete "$name" "${q[@]}" || true; done <<< "$names"
  names=$(listed compute routers list --filter "$named" --format 'value(name,region.basename())')
  while read -r name loc; do [ -n "$name" ] && gcloud compute routers delete "$name" --region "$loc" "${q[@]}" || true; done <<< "$names"
  # The private services range, its peering, then the subnetworks and networks.
  names=$(listed compute networks list --filter "$named" --format 'value(name)')
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    gcloud services vpc-peerings delete --network "$name" --service servicenetworking.googleapis.com "${q[@]}" 2>/dev/null || true
  done <<< "$names"
  names=$(listed compute addresses list --global --filter "$named" --format 'value(name)')
  while IFS= read -r name; do [ -n "$name" ] && gcloud compute addresses delete "$name" --global "${q[@]}" || true; done <<< "$names"
  names=$(listed compute networks subnets list --filter "$named" --format 'value(name,region.basename())')
  while read -r name loc; do [ -n "$name" ] && gcloud compute networks subnets delete "$name" --region "$loc" "${q[@]}" || true; done <<< "$names"
  names=$(listed compute networks list --filter "$named" --format 'value(name)')
  while IFS= read -r name; do [ -n "$name" ] && gcloud compute networks delete "$name" "${q[@]}" || true; done <<< "$names"
  # The plans' service accounts, and what they hold in the project's IAM policy (a destroy that never
  # finished leaves both). Only members of ours: the bindings of anything else are not touched.
  names=$(gcloud projects get-iam-policy "$project" --format json |
    jq -r --arg run "$run_re" '.bindings[]? | select(has("condition") | not) | .role as $role | .members[]? | select(test("^serviceAccount:sa-" + $run + "-")) | "\($role) \(.)"')
  while read -r kind name; do [ -n "$name" ] && gcloud projects remove-iam-policy-binding "$project" --role "$kind" --member "$name" "${q[@]}" > /dev/null || true; done <<< "$names"
  names=$(listed iam service-accounts list --filter "email ~ \"^sa-${run_re}-\"" --format 'value(email)')
  while IFS= read -r name; do [ -n "$name" ] && gcloud iam service-accounts delete "$name" "${q[@]}" || true; done <<< "$names"
}

# What is left, by the same filters: one name a line. Cloud Asset Inventory lags by minutes, so the
# kinds are listed one by one.
left_after_sweep() {
  local named="name ~ \"$name_re\""
  listed run services list --region "$region" --filter "metadata.name ~ \"$name_re\"" --format 'value(metadata.name)'
  listed functions list --filter "name ~ \"/functions/(.*-)?${run_re}(-|\$)\"" --format 'value(name)'
  listed container clusters list --filter "$named" --format 'value(name)'
  for kind in forwarding-rules target-http-proxies target-https-proxies url-maps backend-services addresses; do
    listed compute "$kind" list --global --filter "$named" --format 'value(name)'
  done
  for kind in backend-buckets ssl-certificates ssl-policies security-policies network-endpoint-groups instances disks firewall-rules routers networks; do
    listed compute "$kind" list --filter "$named" --format 'value(name)'
  done
  listed compute networks subnets list --filter "$named" --format 'value(name)'
  listed redis instances list --region "$region" --filter "$named" --format 'value(name)'
  listed sql instances list --filter "$named" --format 'value(name)'
  bq_datasets "$dataset_re"
  listed firestore databases list --filter "$named" --format 'value(name)'
  listed secrets list --filter "$named" --format 'value(name)'
  listed pubsub topics list --filter "$named" --format 'value(name)'
  listed pubsub subscriptions list --filter "$named" --format 'value(name)'
  listed dns managed-zones list --filter "$named" --format 'value(name)'
  listed storage buckets list --filter "$named" --format 'value(name)'
  listed iam service-accounts list --filter "email ~ \"^sa-${run_re}-\"" --format 'value(email)'
}

# The roles no service account of the project may hold, because a plan may attach any service account
# of the project to what it creates and so give a job the roles that account holds, and these let it act
# as, mint credentials for or grant itself the access of other accounts: Editor and Owner, Service Account
# Token Creator, Service Account User, Project IAM Admin, Security Admin, Role Admin and Service Account Key
# Admin. The one exception is Service Account User for the account this job signs in as, which the sandbox
# needs to attach the accounts its plans create (see self_account).
risky_roles=(
  roles/editor
  roles/owner
  roles/iam.serviceAccountTokenCreator
  roles/iam.serviceAccountUser
  roles/resourcemanager.projectIamAdmin
  roles/iam.securityAdmin
  roles/iam.roleAdmin
  roles/iam.serviceAccountKeyAdmin
)

# The email of the service account the credentials file signs in as: the workload identity federation
# configuration names it in its impersonation URL. Empty when it cannot be read, which exempts nothing.
self_account() {
  jq -r '(.service_account_impersonation_url // "") | capture("/serviceAccounts/(?<email>[^/:]+):generateAccessToken").email // empty' "$GOOGLE_APPLICATION_CREDENTIALS" 2> /dev/null || true
}

# Fails closed: a policy that can't be read, or read as something else, fails too. Only the counts are
# printed, never the policy or an account's name; the bootstrap's README has the command that lists them.
preflight() {
  local policy found self roles
  policy=$(gcloud projects get-iam-policy "$project" --format json) || fail "the project's IAM policy could not be read"
  # Nothing at all is not a policy: jq would print nothing for it, which reads as no grants.
  jq -e 'type == "object"' <<< "$policy" > /dev/null 2>&1 || fail "the project's IAM policy could not be read as JSON"
  self=$(self_account)
  roles=$(printf '%s\n' "${risky_roles[@]}" | jq -R . | jq -s -c .)
  found=$(jq -r --argjson roles "$roles" --arg self "$self" '
    if type != "object" then error("not a policy") else . end
    | [.bindings[]? | select(.role as $r | $roles | index($r)) | .role as $role
      | .members[]? | select(test("^serviceAccount:|^principal://iam\\.googleapis\\.com/projects/-/serviceAccounts/"))
      | select(($role == "roles/iam.serviceAccountUser" and $self != ""
          and (sub("^serviceAccount:"; "") | sub("^principal://iam\\.googleapis\\.com/projects/-/serviceAccounts/"; "") | ascii_downcase) == ($self | ascii_downcase)) | not)
      | $role]
    | group_by(.) | map("\(.[0]): \(length)") | join(", ")' <<< "$policy") || fail "the project's IAM policy could not be read as JSON"
  if [ -n "$found" ]; then
    fail "Service accounts hold roles that can act as other accounts or widen access in the project ($found): remove those grants before running this workflow (see the bootstrap's README)"
  fi
  echo "No service account holds Editor, Owner or a role that mints or widens access in the project."
}

case $command in
  generate)
    node "$here/sandbox-gcp-plans.ts" --out "$work"
    ;;
  summary)
    node "$here/sandbox-gcp-plans.ts" --summary
    ;;
  validate)
    # Before any step that can get a token: the plans are another job's. The digest goes in the job's summary,
    # to compare with the other job's, or with the plans generated from the same commit.
    if ! checked=$(node "$here/sandbox-gcp-validate.mjs" "$work"); then
      echo "$checked"
      exit 1
    fi
    echo "$checked"
    if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
      echo "Digest of the plans (job ${GITHUB_JOB:-}): \`${checked##*digest }\`" >> "$GITHUB_STEP_SUMMARY"
    fi
    ;;
  preflight) preflight ;;
  apply) apply_plan "$plan" ;;
  smoke) smoke_plan "$plan" ;;
  destroy) destroy_plan "$plan" ;;
  sweep)
    sweep_all
    left=$(left_after_sweep | sed '/^$/d')
    if [ -n "$left" ]; then
      echo "::error::Left in $project: $(tr '\n' ' ' <<< "$left")"
      exit 1
    fi
    echo "Nothing named $mark is left in $project."
    ;;
  *) fail "unknown command '$command'" ;;
esac
