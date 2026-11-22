export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      api_tokens: {
        Row: {
          created_at: string
          created_by: string | null
          expires_at: string | null
          id: string
          last_used_at: string | null
          name: string
          org_id: string
          repo_scope: string | null
          revoked_at: string | null
          scopes: string[]
          token_hash: string
          token_prefix: string
          token_tail: string
          use_count: number
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          last_used_at?: string | null
          name: string
          org_id: string
          repo_scope?: string | null
          revoked_at?: string | null
          scopes?: string[]
          token_hash: string
          token_prefix: string
          token_tail: string
          use_count?: number
        }
        Update: {
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          last_used_at?: string | null
          name?: string
          org_id?: string
          repo_scope?: string | null
          revoked_at?: string | null
          scopes?: string[]
          token_hash?: string
          token_prefix?: string
          token_tail?: string
          use_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "api_tokens_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          actor_email: string | null
          actor_id: string | null
          actor_type: string
          created_at: string
          id: string
          metadata: Json
          org_id: string | null
          target_id: string | null
          target_label: string | null
          target_type: string | null
        }
        Insert: {
          action: string
          actor_email?: string | null
          actor_id?: string | null
          actor_type?: string
          created_at?: string
          id?: string
          metadata?: Json
          org_id?: string | null
          target_id?: string | null
          target_label?: string | null
          target_type?: string | null
        }
        Update: {
          action?: string
          actor_email?: string | null
          actor_id?: string | null
          actor_type?: string
          created_at?: string
          id?: string
          metadata?: Json
          org_id?: string | null
          target_id?: string | null
          target_label?: string | null
          target_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_targets: {
        Row: {
          campaign_id: string
          concern_id: string
          created_at: string
          file: string | null
          id: string
          org_id: string
          owner_email: string | null
          remediation_id: string | null
          repo_id: string
          rule_id: string
          severity: string
        }
        Insert: {
          campaign_id: string
          concern_id: string
          created_at?: string
          file?: string | null
          id?: string
          org_id: string
          owner_email?: string | null
          remediation_id?: string | null
          repo_id: string
          rule_id: string
          severity?: string
        }
        Update: {
          campaign_id?: string
          concern_id?: string
          created_at?: string
          file?: string | null
          id?: string
          org_id?: string
          owner_email?: string | null
          remediation_id?: string | null
          repo_id?: string
          rule_id?: string
          severity?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaign_targets_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_targets_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_targets_remediation_id_fkey"
            columns: ["remediation_id"]
            isOneToOne: false
            referencedRelation: "remediations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_targets_repo_id_fkey"
            columns: ["repo_id"]
            isOneToOne: false
            referencedRelation: "repos"
            referencedColumns: ["id"]
          },
        ]
      }
      campaigns: {
        Row: {
          closed_at: string | null
          control_id: string | null
          created_at: string
          created_by: string | null
          due_date: string | null
          id: string
          name: string
          org_id: string
          rule_id: string | null
          state: string
        }
        Insert: {
          closed_at?: string | null
          control_id?: string | null
          created_at?: string
          created_by?: string | null
          due_date?: string | null
          id?: string
          name: string
          org_id: string
          rule_id?: string | null
          state?: string
        }
        Update: {
          closed_at?: string | null
          control_id?: string | null
          created_at?: string
          created_by?: string | null
          due_date?: string | null
          id?: string
          name?: string
          org_id?: string
          rule_id?: string | null
          state?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaigns_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          id: string
          stripe_customer_id: string | null
        }
        Insert: {
          id: string
          stripe_customer_id?: string | null
        }
        Update: {
          id?: string
          stripe_customer_id?: string | null
        }
        Relationships: []
      }
      findings: {
        Row: {
          assessability: Database["public"]["Enums"]["finding_assessability"]
          category: Database["public"]["Enums"]["finding_category"] | null
          code_snippet: string | null
          compliance: string[]
          concern_id: string
          concern_key: string
          created_at: string
          doc_url: string | null
          evidence: string | null
          file: string | null
          id: string
          line: number | null
          org_id: string
          remediation_hint: string | null
          repo_id: string
          risk_score: number | null
          rule_id: string
          run_id: string | null
          severity: Database["public"]["Enums"]["finding_severity"]
          source: string
          suppressed: boolean
          suppression_expires: string | null
          suppression_reason: string | null
          suppression_source: string | null
        }
        Insert: {
          assessability?: Database["public"]["Enums"]["finding_assessability"]
          category?: Database["public"]["Enums"]["finding_category"] | null
          code_snippet?: string | null
          compliance?: string[]
          concern_id: string
          concern_key: string
          created_at?: string
          doc_url?: string | null
          evidence?: string | null
          file?: string | null
          id?: string
          line?: number | null
          org_id: string
          remediation_hint?: string | null
          repo_id: string
          risk_score?: number | null
          rule_id: string
          run_id?: string | null
          severity: Database["public"]["Enums"]["finding_severity"]
          source: string
          suppressed?: boolean
          suppression_expires?: string | null
          suppression_reason?: string | null
          suppression_source?: string | null
        }
        Update: {
          assessability?: Database["public"]["Enums"]["finding_assessability"]
          category?: Database["public"]["Enums"]["finding_category"] | null
          code_snippet?: string | null
          compliance?: string[]
          concern_id?: string
          concern_key?: string
          created_at?: string
          doc_url?: string | null
          evidence?: string | null
          file?: string | null
          id?: string
          line?: number | null
          org_id?: string
          remediation_hint?: string | null
          repo_id?: string
          risk_score?: number | null
          rule_id?: string
          run_id?: string | null
          severity?: Database["public"]["Enums"]["finding_severity"]
          source?: string
          suppressed?: boolean
          suppression_expires?: string | null
          suppression_reason?: string | null
          suppression_source?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "findings_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "findings_repo_id_fkey"
            columns: ["repo_id"]
            isOneToOne: false
            referencedRelation: "repos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "findings_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      grc_connections: {
        Row: {
          config: Json
          created_at: string
          created_by: string | null
          enabled: boolean
          framework_id: string
          id: string
          last_error: string | null
          last_pushed_at: string | null
          org_id: string
          provider: string
          updated_at: string
        }
        Insert: {
          config?: Json
          created_at?: string
          created_by?: string | null
          enabled?: boolean
          framework_id: string
          id?: string
          last_error?: string | null
          last_pushed_at?: string | null
          org_id: string
          provider: string
          updated_at?: string
        }
        Update: {
          config?: Json
          created_at?: string
          created_by?: string | null
          enabled?: boolean
          framework_id?: string
          id?: string
          last_error?: string | null
          last_pushed_at?: string | null
          org_id?: string
          provider?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "grc_connections_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      grc_deliveries: {
        Row: {
          attempts: number
          connection_id: string
          content_hash: string
          created_at: string
          delivered_at: string | null
          error: string | null
          http_status: number | null
          id: string
          org_id: string
          record: Json
          signature_key_id: string | null
          status: string
        }
        Insert: {
          attempts?: number
          connection_id: string
          content_hash: string
          created_at?: string
          delivered_at?: string | null
          error?: string | null
          http_status?: number | null
          id?: string
          org_id: string
          record: Json
          signature_key_id?: string | null
          status?: string
        }
        Update: {
          attempts?: number
          connection_id?: string
          content_hash?: string
          created_at?: string
          delivered_at?: string | null
          error?: string | null
          http_status?: number | null
          id?: string
          org_id?: string
          record?: Json
          signature_key_id?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "grc_deliveries_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "grc_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grc_deliveries_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      instance_metrics: {
        Row: {
          active_developers: number
          active_repos: number
          created_at: string
          findings_opened: number
          findings_resolved: number
          id: string
          instance_id: string
          period_start: string
          remediation_prs: number
          scans: number
        }
        Insert: {
          active_developers?: number
          active_repos?: number
          created_at?: string
          findings_opened?: number
          findings_resolved?: number
          id?: string
          instance_id: string
          period_start: string
          remediation_prs?: number
          scans?: number
        }
        Update: {
          active_developers?: number
          active_repos?: number
          created_at?: string
          findings_opened?: number
          findings_resolved?: number
          id?: string
          instance_id?: string
          period_start?: string
          remediation_prs?: number
          scans?: number
        }
        Relationships: [
          {
            foreignKeyName: "instance_metrics_instance_id_fkey"
            columns: ["instance_id"]
            isOneToOne: false
            referencedRelation: "managed_instances"
            referencedColumns: ["id"]
          },
        ]
      }
      jobs: {
        Row: {
          attempts: number
          created_at: string
          id: string
          last_error: string | null
          max_attempts: number
          org_id: string | null
          payload: Json
          run_after: string
          status: Database["public"]["Enums"]["job_status"]
          type: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          id?: string
          last_error?: string | null
          max_attempts?: number
          org_id?: string | null
          payload?: Json
          run_after?: string
          status?: Database["public"]["Enums"]["job_status"]
          type: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          created_at?: string
          id?: string
          last_error?: string | null
          max_attempts?: number
          org_id?: string | null
          payload?: Json
          run_after?: string
          status?: Database["public"]["Enums"]["job_status"]
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "jobs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      managed_instances: {
        Row: {
          app_version: string | null
          created_at: string
          id: string
          label: string | null
          last_seen_at: string | null
          region: string
          slug: string
          status: string
          tier: string
          token_hash: string
        }
        Insert: {
          app_version?: string | null
          created_at?: string
          id?: string
          label?: string | null
          last_seen_at?: string | null
          region: string
          slug: string
          status?: string
          tier?: string
          token_hash: string
        }
        Update: {
          app_version?: string | null
          created_at?: string
          id?: string
          label?: string | null
          last_seen_at?: string | null
          region?: string
          slug?: string
          status?: string
          tier?: string
          token_hash?: string
        }
        Relationships: []
      }
      membership_repo_grants: {
        Row: {
          created_at: string
          org_id: string
          repo_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          org_id: string
          repo_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          org_id?: string
          repo_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "membership_repo_grants_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "membership_repo_grants_repo_id_fkey"
            columns: ["repo_id"]
            isOneToOne: false
            referencedRelation: "repos"
            referencedColumns: ["id"]
          },
        ]
      }
      memberships: {
        Row: {
          created_at: string
          invited_by: string | null
          invited_by_email: string | null
          joined_via: string | null
          org_id: string
          role: Database["public"]["Enums"]["org_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          invited_by?: string | null
          invited_by_email?: string | null
          joined_via?: string | null
          org_id: string
          role?: Database["public"]["Enums"]["org_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          invited_by?: string | null
          invited_by_email?: string | null
          joined_via?: string | null
          org_id?: string
          role?: Database["public"]["Enums"]["org_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "memberships_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      native_skips: {
        Row: {
          created_at: string
          expires: string | null
          file: string
          first_seen_at: string
          id: string
          line: number
          org_id: string
          reason: string
          repo_id: string
          rule: string
          tool: string
        }
        Insert: {
          created_at?: string
          expires?: string | null
          file: string
          first_seen_at?: string
          id?: string
          line?: number
          org_id: string
          reason?: string
          repo_id: string
          rule: string
          tool: string
        }
        Update: {
          created_at?: string
          expires?: string | null
          file?: string
          first_seen_at?: string
          id?: string
          line?: number
          org_id?: string
          reason?: string
          repo_id?: string
          rule?: string
          tool?: string
        }
        Relationships: [
          {
            foreignKeyName: "native_skips_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "native_skips_repo_id_fkey"
            columns: ["repo_id"]
            isOneToOne: false
            referencedRelation: "repos"
            referencedColumns: ["id"]
          },
        ]
      }
      org_framework_reporting: {
        Row: {
          framework_id: string
          id: string
          org_id: string
          reporting: boolean
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          framework_id: string
          id?: string
          org_id: string
          reporting?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          framework_id?: string
          id?: string
          org_id?: string
          reporting?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "org_framework_reporting_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      org_invites: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_by: string | null
          invited_by_user_id: string | null
          org_id: string
          repo_ids: string[]
          role: Database["public"]["Enums"]["org_role"]
          token_hash: string
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          created_at?: string
          email: string
          expires_at: string
          id?: string
          invited_by?: string | null
          invited_by_user_id?: string | null
          org_id: string
          repo_ids?: string[]
          role?: Database["public"]["Enums"]["org_role"]
          token_hash: string
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string | null
          invited_by_user_id?: string | null
          org_id?: string
          repo_ids?: string[]
          role?: Database["public"]["Enums"]["org_role"]
          token_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_invites_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      org_policy_rules: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          attribute: string
          created_at: string
          created_by: string | null
          created_by_user_id: string | null
          example_compliant: Json | null
          example_violating: Json | null
          id: string
          message: string
          operator: string
          org_id: string
          resource_type: string
          rule_id: string
          self_test: Json | null
          severity: string
          source_requirement: string
          state: string
          theme: string
          title: string
          value: Json | null
          when_absent: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          attribute: string
          created_at?: string
          created_by?: string | null
          created_by_user_id?: string | null
          example_compliant?: Json | null
          example_violating?: Json | null
          id?: string
          message: string
          operator: string
          org_id: string
          resource_type: string
          rule_id: string
          self_test?: Json | null
          severity?: string
          source_requirement: string
          state?: string
          theme: string
          title: string
          value?: Json | null
          when_absent: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          attribute?: string
          created_at?: string
          created_by?: string | null
          created_by_user_id?: string | null
          example_compliant?: Json | null
          example_violating?: Json | null
          id?: string
          message?: string
          operator?: string
          org_id?: string
          resource_type?: string
          rule_id?: string
          self_test?: Json | null
          severity?: string
          source_requirement?: string
          state?: string
          theme?: string
          title?: string
          value?: Json | null
          when_absent?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_policy_rules_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      org_required_controls: {
        Row: {
          control_code: string
          created_at: string
          created_by: string | null
          framework_id: string | null
          id: string
          org_id: string
        }
        Insert: {
          control_code: string
          created_at?: string
          created_by?: string | null
          framework_id?: string | null
          id?: string
          org_id: string
        }
        Update: {
          control_code?: string
          created_at?: string
          created_by?: string | null
          framework_id?: string | null
          id?: string
          org_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_required_controls_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      org_sso: {
        Row: {
          created_at: string
          email_domain: string
          org_id: string
          provider_id: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          email_domain: string
          org_id: string
          provider_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          email_domain?: string
          org_id?: string
          provider_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_sso_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      org_sso_domains: {
        Row: {
          created_at: string
          domain: string
          org_id: string
          updated_at: string
          verification_token: string
          verified_at: string | null
        }
        Insert: {
          created_at?: string
          domain: string
          org_id: string
          updated_at?: string
          verification_token: string
          verified_at?: string | null
        }
        Update: {
          created_at?: string
          domain?: string
          org_id?: string
          updated_at?: string
          verification_token?: string
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "org_sso_domains_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      orgs: {
        Row: {
          created_at: string
          crosswalk_tier: string | null
          currency: string
          github_installation_id: number | null
          github_login: string
          id: string
          managed_monthly_cap_pence: number
          managed_opt_out: boolean
          name: string | null
          plan: Database["public"]["Enums"]["org_plan"]
          require_suppression_approval: boolean
          residency_region: string
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
        }
        Insert: {
          created_at?: string
          crosswalk_tier?: string | null
          currency?: string
          github_installation_id?: number | null
          github_login: string
          id?: string
          managed_monthly_cap_pence?: number
          managed_opt_out?: boolean
          name?: string | null
          plan?: Database["public"]["Enums"]["org_plan"]
          require_suppression_approval?: boolean
          residency_region?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
        }
        Update: {
          created_at?: string
          crosswalk_tier?: string | null
          currency?: string
          github_installation_id?: number | null
          github_login?: string
          id?: string
          managed_monthly_cap_pence?: number
          managed_opt_out?: boolean
          name?: string | null
          plan?: Database["public"]["Enums"]["org_plan"]
          require_suppression_approval?: boolean
          residency_region?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
        }
        Relationships: []
      }
      outcomes: {
        Row: {
          concern_ids: string[]
          created_at: string
          human_added_lines: string[]
          human_intervened: boolean
          id: string
          org_id: string
          outcome: Database["public"]["Enums"]["remediation_outcome"]
          pr_number: number | null
          removed_from_original: string[]
          repo_id: string
        }
        Insert: {
          concern_ids?: string[]
          created_at?: string
          human_added_lines?: string[]
          human_intervened?: boolean
          id?: string
          org_id: string
          outcome: Database["public"]["Enums"]["remediation_outcome"]
          pr_number?: number | null
          removed_from_original?: string[]
          repo_id: string
        }
        Update: {
          concern_ids?: string[]
          created_at?: string
          human_added_lines?: string[]
          human_intervened?: boolean
          id?: string
          org_id?: string
          outcome?: Database["public"]["Enums"]["remediation_outcome"]
          pr_number?: number | null
          removed_from_original?: string[]
          repo_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "outcomes_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outcomes_repo_id_fkey"
            columns: ["repo_id"]
            isOneToOne: false
            referencedRelation: "repos"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_super_owner_invites: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_by: string | null
          token_hash: string
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          created_at?: string
          email: string
          expires_at: string
          id?: string
          invited_by?: string | null
          token_hash: string
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string | null
          token_hash?: string
        }
        Relationships: []
      }
      platform_super_owners: {
        Row: {
          created_at: string
          granted_by: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          granted_by?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          granted_by?: string | null
          user_id?: string
        }
        Relationships: []
      }
      proven_fix_patterns: {
        Row: {
          before_example: string | null
          canonical_class: string | null
          category: string | null
          description: string | null
          disabled: boolean
          finding_type: string
          first_proven_at: string
          id: string
          last_repo_id: string | null
          last_run_id: string | null
          org_id: string
          remediation_hint: string | null
          repos_proven: string[]
          source: string | null
          times_proven: number
          title: string
          updated_at: string
        }
        Insert: {
          before_example?: string | null
          canonical_class?: string | null
          category?: string | null
          description?: string | null
          disabled?: boolean
          finding_type: string
          first_proven_at?: string
          id?: string
          last_repo_id?: string | null
          last_run_id?: string | null
          org_id: string
          remediation_hint?: string | null
          repos_proven?: string[]
          source?: string | null
          times_proven?: number
          title: string
          updated_at?: string
        }
        Update: {
          before_example?: string | null
          canonical_class?: string | null
          category?: string | null
          description?: string | null
          disabled?: boolean
          finding_type?: string
          first_proven_at?: string
          id?: string
          last_repo_id?: string | null
          last_run_id?: string | null
          org_id?: string
          remediation_hint?: string | null
          repos_proven?: string[]
          source?: string | null
          times_proven?: number
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "proven_fix_patterns_last_repo_id_fkey"
            columns: ["last_repo_id"]
            isOneToOne: false
            referencedRelation: "repos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proven_fix_patterns_last_run_id_fkey"
            columns: ["last_run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proven_fix_patterns_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      proven_transforms: {
        Row: {
          disabled: boolean
          first_proven_at: string
          from_major: number
          id: string
          last_repo_id: string | null
          last_run_id: string | null
          org_id: string
          provider: string
          repos_proven: string[]
          times_proven: number
          to_major: number
          transform_id: string
          updated_at: string
        }
        Insert: {
          disabled?: boolean
          first_proven_at?: string
          from_major: number
          id?: string
          last_repo_id?: string | null
          last_run_id?: string | null
          org_id: string
          provider: string
          repos_proven?: string[]
          times_proven?: number
          to_major: number
          transform_id: string
          updated_at?: string
        }
        Update: {
          disabled?: boolean
          first_proven_at?: string
          from_major?: number
          id?: string
          last_repo_id?: string | null
          last_run_id?: string | null
          org_id?: string
          provider?: string
          repos_proven?: string[]
          times_proven?: number
          to_major?: number
          transform_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "proven_transforms_last_repo_id_fkey"
            columns: ["last_repo_id"]
            isOneToOne: false
            referencedRelation: "repos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proven_transforms_last_run_id_fkey"
            columns: ["last_run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proven_transforms_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_limit_buckets: {
        Row: {
          count: number
          key: string
          reset_at: string
        }
        Insert: {
          count: number
          key: string
          reset_at: string
        }
        Update: {
          count?: number
          key?: string
          reset_at?: string
        }
        Relationships: []
      }
      remediations: {
        Row: {
          blast_radius: string | null
          branch: string | null
          concern_ids: string[]
          confidence: number | null
          cost_delta: number | null
          created_at: string
          equivalence_verdict: string | null
          id: string
          mode: string | null
          module_source: string | null
          module_version: string | null
          moved_block_count: number | null
          org_id: string
          pr_event_at: string | null
          pr_number: number | null
          proposed_unproven: boolean | null
          refactor_source: string | null
          repo_id: string
          requested_by: string | null
          run_id: string | null
          state: string | null
          uncovered_moves: number | null
          verdict: string | null
        }
        Insert: {
          blast_radius?: string | null
          branch?: string | null
          concern_ids?: string[]
          confidence?: number | null
          cost_delta?: number | null
          created_at?: string
          equivalence_verdict?: string | null
          id?: string
          mode?: string | null
          module_source?: string | null
          module_version?: string | null
          moved_block_count?: number | null
          org_id: string
          pr_event_at?: string | null
          pr_number?: number | null
          proposed_unproven?: boolean | null
          refactor_source?: string | null
          repo_id: string
          requested_by?: string | null
          run_id?: string | null
          state?: string | null
          uncovered_moves?: number | null
          verdict?: string | null
        }
        Update: {
          blast_radius?: string | null
          branch?: string | null
          concern_ids?: string[]
          confidence?: number | null
          cost_delta?: number | null
          created_at?: string
          equivalence_verdict?: string | null
          id?: string
          mode?: string | null
          module_source?: string | null
          module_version?: string | null
          moved_block_count?: number | null
          org_id?: string
          pr_event_at?: string | null
          pr_number?: number | null
          proposed_unproven?: boolean | null
          refactor_source?: string | null
          repo_id?: string
          requested_by?: string | null
          run_id?: string | null
          state?: string | null
          uncovered_moves?: number | null
          verdict?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "remediations_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "remediations_repo_id_fkey"
            columns: ["repo_id"]
            isOneToOne: false
            referencedRelation: "repos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "remediations_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      repos: {
        Row: {
          badge_public: boolean
          ce_score: number | null
          created_at: string
          default_branch: string | null
          id: string
          last_seen_at: string | null
          name: string
          org_id: string
          oss: boolean
          owner: string
          paused: boolean
          posture: string | null
          private: boolean | null
          prs_open: number
          report_status: string
          settings: Json | null
          source: string
        }
        Insert: {
          badge_public?: boolean
          ce_score?: number | null
          created_at?: string
          default_branch?: string | null
          id?: string
          last_seen_at?: string | null
          name: string
          org_id: string
          oss?: boolean
          owner: string
          paused?: boolean
          posture?: string | null
          private?: boolean | null
          prs_open?: number
          report_status?: string
          settings?: Json | null
          source?: string
        }
        Update: {
          badge_public?: boolean
          ce_score?: number | null
          created_at?: string
          default_branch?: string | null
          id?: string
          last_seen_at?: string | null
          name?: string
          org_id?: string
          oss?: boolean
          owner?: string
          paused?: boolean
          posture?: string | null
          private?: boolean | null
          prs_open?: number
          report_status?: string
          settings?: Json | null
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "repos_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      run_activities: {
        Row: {
          created_at: string
          external_run_id: string
          id: string
          message: string
          occurred_at: string
          org_id: string
          phase: Database["public"]["Enums"]["run_activity_phase"]
          repo_id: string
          seq: number
        }
        Insert: {
          created_at?: string
          external_run_id: string
          id?: string
          message?: string
          occurred_at: string
          org_id: string
          phase: Database["public"]["Enums"]["run_activity_phase"]
          repo_id: string
          seq: number
        }
        Update: {
          created_at?: string
          external_run_id?: string
          id?: string
          message?: string
          occurred_at?: string
          org_id?: string
          phase?: Database["public"]["Enums"]["run_activity_phase"]
          repo_id?: string
          seq?: number
        }
        Relationships: [
          {
            foreignKeyName: "run_activities_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "run_activities_repo_id_fkey"
            columns: ["repo_id"]
            isOneToOne: false
            referencedRelation: "repos"
            referencedColumns: ["id"]
          },
        ]
      }
      run_learnings: {
        Row: {
          learnings: string | null
          model: string | null
          org_id: string
          repo_id: string
          updated_at: string
        }
        Insert: {
          learnings?: string | null
          model?: string | null
          org_id: string
          repo_id: string
          updated_at?: string
        }
        Update: {
          learnings?: string | null
          model?: string | null
          org_id?: string
          repo_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "run_learnings_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "run_learnings_repo_id_fkey"
            columns: ["repo_id"]
            isOneToOne: true
            referencedRelation: "repos"
            referencedColumns: ["id"]
          },
        ]
      }
      runs: {
        Row: {
          api_token_id: string | null
          artifacts: Json
          cache_read_tokens: number
          cache_write_tokens: number
          ce_score: number | null
          commit_sha: string | null
          compliance_verdicts: Json | null
          cost_usd: number
          created_at: string
          credential: string | null
          crosswalk_version: string | null
          duration_ms: number | null
          engine_crosswalk_version: string | null
          external_run_id: string | null
          findings_fixed: number | null
          findings_new: number | null
          findings_unchanged: number | null
          finished_at: string | null
          id: string
          input_tokens: number
          mode: Database["public"]["Enums"]["run_mode"] | null
          model: string | null
          org_id: string
          output_tokens: number
          pr_number: number | null
          repo_id: string | null
          report_key: string | null
          review: Json | null
          run_number: number | null
          standards_report: Json | null
          started_at: string | null
          status: Database["public"]["Enums"]["run_status"]
          trigger: string | null
        }
        Insert: {
          api_token_id?: string | null
          artifacts?: Json
          cache_read_tokens?: number
          cache_write_tokens?: number
          ce_score?: number | null
          commit_sha?: string | null
          compliance_verdicts?: Json | null
          cost_usd?: number
          created_at?: string
          credential?: string | null
          crosswalk_version?: string | null
          duration_ms?: number | null
          engine_crosswalk_version?: string | null
          external_run_id?: string | null
          findings_fixed?: number | null
          findings_new?: number | null
          findings_unchanged?: number | null
          finished_at?: string | null
          id?: string
          input_tokens?: number
          mode?: Database["public"]["Enums"]["run_mode"] | null
          model?: string | null
          org_id: string
          output_tokens?: number
          pr_number?: number | null
          repo_id?: string | null
          report_key?: string | null
          review?: Json | null
          run_number?: number | null
          standards_report?: Json | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["run_status"]
          trigger?: string | null
        }
        Update: {
          api_token_id?: string | null
          artifacts?: Json
          cache_read_tokens?: number
          cache_write_tokens?: number
          ce_score?: number | null
          commit_sha?: string | null
          compliance_verdicts?: Json | null
          cost_usd?: number
          created_at?: string
          credential?: string | null
          crosswalk_version?: string | null
          duration_ms?: number | null
          engine_crosswalk_version?: string | null
          external_run_id?: string | null
          findings_fixed?: number | null
          findings_new?: number | null
          findings_unchanged?: number | null
          finished_at?: string | null
          id?: string
          input_tokens?: number
          mode?: Database["public"]["Enums"]["run_mode"] | null
          model?: string | null
          org_id?: string
          output_tokens?: number
          pr_number?: number | null
          repo_id?: string | null
          report_key?: string | null
          review?: Json | null
          run_number?: number | null
          standards_report?: Json | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["run_status"]
          trigger?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "runs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "runs_repo_id_fkey"
            columns: ["repo_id"]
            isOneToOne: false
            referencedRelation: "repos"
            referencedColumns: ["id"]
          },
        ]
      }
      runtime_secrets: {
        Row: {
          id: string
          name: string
          org_id: string
          repo_id: string | null
          updated_at: string
          value: string
        }
        Insert: {
          id?: string
          name: string
          org_id: string
          repo_id?: string | null
          updated_at?: string
          value: string
        }
        Update: {
          id?: string
          name?: string
          org_id?: string
          repo_id?: string | null
          updated_at?: string
          value?: string
        }
        Relationships: [
          {
            foreignKeyName: "runtime_secrets_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "runtime_secrets_repo_id_fkey"
            columns: ["repo_id"]
            isOneToOne: false
            referencedRelation: "repos"
            referencedColumns: ["id"]
          },
        ]
      }
      scim_users: {
        Row: {
          active: boolean
          created_at: string
          display_name: string | null
          external_id: string | null
          id: string
          org_id: string
          updated_at: string
          user_id: string | null
          user_name: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          display_name?: string | null
          external_id?: string | null
          id?: string
          org_id: string
          updated_at?: string
          user_id?: string | null
          user_name: string
        }
        Update: {
          active?: boolean
          created_at?: string
          display_name?: string | null
          external_id?: string | null
          id?: string
          org_id?: string
          updated_at?: string
          user_id?: string | null
          user_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "scim_users_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      suppression_policies: {
        Row: {
          created_at: string
          created_by: string | null
          created_by_user_id: string | null
          expires: string | null
          id: string
          justification: string | null
          org_id: string
          paths: string[]
          ratified_at: string | null
          ratified_by: string | null
          reason: string
          repo_id: string | null
          rule: string
          state: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          created_by_user_id?: string | null
          expires?: string | null
          id?: string
          justification?: string | null
          org_id: string
          paths?: string[]
          ratified_at?: string | null
          ratified_by?: string | null
          reason: string
          repo_id?: string | null
          rule: string
          state?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          created_by_user_id?: string | null
          expires?: string | null
          id?: string
          justification?: string | null
          org_id?: string
          paths?: string[]
          ratified_at?: string | null
          ratified_by?: string | null
          reason?: string
          repo_id?: string | null
          rule?: string
          state?: string
        }
        Relationships: [
          {
            foreignKeyName: "suppression_policies_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "suppression_policies_repo_id_fkey"
            columns: ["repo_id"]
            isOneToOne: false
            referencedRelation: "repos"
            referencedColumns: ["id"]
          },
        ]
      }
      terragram_evidence_bundles: {
        Row: {
          approved_at: string
          approver: string
          cloud: string
          content_hash: string
          created_at: string
          engine: string
          explanation: string | null
          id: string
          key_id: string | null
          model: Json
          plan: Json
          signature: string | null
          tool: string
          user_id: string
          workspace_id: string | null
        }
        Insert: {
          approved_at: string
          approver: string
          cloud: string
          content_hash: string
          created_at?: string
          engine: string
          explanation?: string | null
          id?: string
          key_id?: string | null
          model: Json
          plan: Json
          signature?: string | null
          tool?: string
          user_id: string
          workspace_id?: string | null
        }
        Update: {
          approved_at?: string
          approver?: string
          cloud?: string
          content_hash?: string
          created_at?: string
          engine?: string
          explanation?: string | null
          id?: string
          key_id?: string | null
          model?: Json
          plan?: Json
          signature?: string | null
          tool?: string
          user_id?: string
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "terragram_evidence_bundles_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "terragram_workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      terragram_git_connections: {
        Row: {
          access_token: string
          account_login: string
          created_at: string
          expires_at: string | null
          id: string
          provider: string
          refresh_token: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token: string
          account_login: string
          created_at?: string
          expires_at?: string | null
          id?: string
          provider: string
          refresh_token?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          access_token?: string
          account_login?: string
          created_at?: string
          expires_at?: string | null
          id?: string
          provider?: string
          refresh_token?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      terragram_share_links: {
        Row: {
          created_at: string
          created_by: string
          expires_at: string
          id: string
          revoked_at: string | null
          token_hash: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by: string
          expires_at: string
          id?: string
          revoked_at?: string | null
          token_hash: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string
          expires_at?: string
          id?: string
          revoked_at?: string | null
          token_hash?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "terragram_share_links_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "terragram_workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      terragram_user_settings: {
        Row: {
          settings: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          settings?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          settings?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      terragram_workspace_snapshots: {
        Row: {
          created_at: string
          id: string
          model: Json
          transcript: Json | null
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          model: Json
          transcript?: Json | null
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          model?: Json
          transcript?: Json | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "terragram_workspace_snapshots_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "terragram_workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      terragram_workspaces: {
        Row: {
          cloud: string
          created_at: string
          id: string
          mode: string
          name: string
          tool: string
          updated_at: string
          user_id: string
        }
        Insert: {
          cloud?: string
          created_at?: string
          id?: string
          mode?: string
          name: string
          tool?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          cloud?: string
          created_at?: string
          id?: string
          mode?: string
          name?: string
          tool?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      usage_events: {
        Row: {
          created_at: string
          id: string
          kind: string
          org_id: string
          product: string
          quantity: number
          reported_at: string | null
          run_id: string | null
          stripe_meter_event_id: string | null
          usage_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          kind: string
          org_id: string
          product?: string
          quantity?: number
          reported_at?: string | null
          run_id?: string | null
          stripe_meter_event_id?: string | null
          usage_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          org_id?: string
          product?: string
          quantity?: number
          reported_at?: string | null
          run_id?: string | null
          stripe_meter_event_id?: string | null
          usage_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "usage_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usage_events_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          avatar_url: string | null
          banned_until: string | null
          email: string | null
          full_name: string | null
          id: string
          last_sign_in_at: string | null
          locale: string | null
        }
        Insert: {
          avatar_url?: string | null
          banned_until?: string | null
          email?: string | null
          full_name?: string | null
          id: string
          last_sign_in_at?: string | null
          locale?: string | null
        }
        Update: {
          avatar_url?: string | null
          banned_until?: string | null
          email?: string | null
          full_name?: string | null
          id?: string
          last_sign_in_at?: string | null
          locale?: string | null
        }
        Relationships: []
      }
      worker_heartbeats: {
        Row: {
          detail: Json
          name: string
          ticked_at: string
        }
        Insert: {
          detail?: Json
          name: string
          ticked_at?: string
        }
        Update: {
          detail?: Json
          name?: string
          ticked_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      bump_token_usage: { Args: { p_token_id: string }; Returns: undefined }
      campaign_open_control_candidates: {
        Args: { p_org_id: string }
        Returns: {
          control_id: string
          n: number
        }[]
      }
      campaign_open_rule_candidates: {
        Args: { p_org_id: string }
        Returns: {
          n: number
          rule_id: string
          severity: Database["public"]["Enums"]["finding_severity"]
        }[]
      }
      claim_first_super_owner: {
        Args: { p_email: string; p_user: string }
        Returns: boolean
      }
      claim_job: {
        Args: never
        Returns: {
          attempts: number
          created_at: string
          id: string
          last_error: string | null
          max_attempts: number
          org_id: string | null
          payload: Json
          run_after: string
          status: Database["public"]["Enums"]["job_status"]
          type: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_jobs: {
        Args: { p_limit: number }
        Returns: {
          attempts: number
          created_at: string
          id: string
          last_error: string | null
          max_attempts: number
          org_id: string | null
          payload: Json
          run_after: string
          status: Database["public"]["Enums"]["job_status"]
          type: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      compliance_control_counts: {
        Args: { p_org_id: string }
        Returns: {
          assessability: Database["public"]["Enums"]["finding_assessability"]
          control_code: string
          n: number
        }[]
      }
      consume_rate_limit: {
        Args: { p_key: string; p_limit: number; p_window_ms: number }
        Returns: {
          allowed: boolean
          retry_after_ms: number
        }[]
      }
      erase_audit_actor: {
        Args: { p_email: string; p_user: string }
        Returns: number
      }
      github_logins_for_org: { Args: { p_org: string }; Returns: string[] }
      is_org_member: { Args: { p_org: string }; Returns: boolean }
      latest_run_activity: {
        Args: { p_limit?: number; p_org: string; p_repo: string }
        Returns: {
          external_run_id: string
          message: string
          occurred_at: string
          phase: Database["public"]["Enums"]["run_activity_phase"]
          seq: number
        }[]
      }
      managed_mint_reconciliation: {
        Args: { p_product?: string; p_since: string }
        Returns: {
          mints: number
          org_id: string
          usage_reports: number
        }[]
      }
      merge_run_artifacts: {
        Args: { p_org: string; p_patch: Json; p_run: string }
        Returns: boolean
      }
      operator_latest_instance_metrics: {
        Args: never
        Returns: {
          active_developers: number
          active_repos: number
          created_at: string
          findings_opened: number
          findings_resolved: number
          id: string
          instance_id: string
          period_start: string
          remediation_prs: number
          scans: number
        }[]
        SetofOptions: {
          from: "*"
          to: "instance_metrics"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      operator_latest_run_models: {
        Args: never
        Returns: {
          model: string
          org_id: string
        }[]
      }
      operator_org_counts: {
        Args: never
        Returns: {
          app_repos: number
          members: number
          org_id: string
          repos: number
          token_repos: number
        }[]
      }
      orgs_with_unreported_usage: {
        Args: { p_kind: string; p_product?: string }
        Returns: {
          org_id: string
        }[]
      }
      provision_personal_org: {
        Args: { p_login: string; p_name: string; p_user: string }
        Returns: {
          created: boolean
          org_id: string
        }[]
      }
      prune_rate_limit_buckets: { Args: never; Returns: number }
      public_repo_badge: {
        Args: { p_name: string; p_owner: string }
        Returns: {
          ce_score: number
          posture: string
        }[]
      }
      purge_aged_telemetry: { Args: never; Returns: number }
      purge_finished_jobs: { Args: never; Returns: number }
      purge_revoked_tokens: { Args: never; Returns: number }
      ratify_suppression_policy: {
        Args: {
          p_id: string
          // hand-corrected on generation: nullable (justification is optional). Postgres records no
          // nullability for function args, so gen-types cannot infer it — see
          // NULLABLE_FUNCTION_ARGS in scripts/supabase-cli.mjs.
          p_justification: string | null
          p_org: string
          p_ratifier: string
          p_ratifier_id: string
        }
        Returns: string
      }
      record_managed_usage: {
        Args: {
          p_allowance_pence: number
          p_cap_pence?: number
          p_cost_pence: number
          p_org: string
          p_product?: string
          p_since: string
          p_usage_id: string
        }
        Returns: Json
      }
      record_remediation_close: {
        Args: {
          // hand-corrected on generation: nullable (a pull_request payload need not carry head.ref). Postgres records no
          // nullability for function args, so gen-types cannot infer it — see
          // NULLABLE_FUNCTION_ARGS in scripts/supabase-cli.mjs.
          p_branch: string | null
          // hand-corrected on generation: nullable (a payload without updated_at degrades to an unconditional write). Postgres records no
          // nullability for function args, so gen-types cannot infer it — see
          // NULLABLE_FUNCTION_ARGS in scripts/supabase-cli.mjs.
          p_event_at: string | null
          p_org: string
          p_pr: number
          p_repo: string
          p_state: string
        }
        Returns: boolean
      }
      remove_super_owner: { Args: { p_user: string }; Returns: string }
      replace_repo_findings: {
        Args: { p_org: string; p_repo: string; p_rows: Json; p_run: string }
        Returns: undefined
      }
      repo_open_severity_counts: {
        Args: { p_org_id: string }
        Returns: {
          n: number
          repo_id: string
          severity: Database["public"]["Enums"]["finding_severity"]
        }[]
      }
      repos_with_successful_runs: {
        Args: { p_org: string; p_repos: string[] }
        Returns: number
      }
      revoke_user_sessions: { Args: { p_user: string }; Returns: undefined }
      set_membership: {
        Args: {
          p_org: string
          // hand-corrected on generation: nullable (null clears the role). Postgres records no
          // nullability for function args, so gen-types cannot infer it — see
          // NULLABLE_FUNCTION_ARGS in scripts/supabase-cli.mjs.
          p_role: Database["public"]["Enums"]["org_role"] | null
          p_user: string
        }
        Returns: string
      }
      usage_totals_since: {
        Args: { p_org: string; p_product?: string; p_since: string }
        Returns: {
          kind: string
          total: number
        }[]
      }
    }
    Enums: {
      finding_assessability:
        | "pass"
        | "fail"
        | "not-applicable"
        | "inconclusive"
        | "not-code-verifiable"
      finding_category: "security" | "style" | "correctness" | "cost"
      finding_severity: "critical" | "high" | "medium" | "low" | "info"
      job_status: "queued" | "active" | "done" | "failed"
      org_plan: "none" | "payg"
      org_role: "admin" | "maintainer" | "auditor" | "billing_manager"
      remediation_outcome: "merged_clean" | "merged_with_edits" | "rejected"
      run_activity_phase:
        | "queued"
        | "planning"
        | "progress"
        | "completed"
        | "failed"
      run_mode:
        | "remediate"
        | "assess"
        | "generate"
        | "review"
        | "refactor"
        | "remediate-refactor"
        | "policygate"
        | "updatedependencies"
        | "modernizedeprecated"
        | "costoptimization"
        | "driftdetect"
        | "complianceaudit"
        | "summarizepr"
        | "incrementalreview"
        | "addressreviews"
        | "resolveconflicts"
        | "terraformcodereview"
      run_status: "queued" | "running" | "success" | "failed"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      finding_assessability: [
        "pass",
        "fail",
        "not-applicable",
        "inconclusive",
        "not-code-verifiable",
      ],
      finding_category: ["security", "style", "correctness", "cost"],
      finding_severity: ["critical", "high", "medium", "low", "info"],
      job_status: ["queued", "active", "done", "failed"],
      org_plan: ["none", "payg"],
      org_role: ["admin", "maintainer", "auditor", "billing_manager"],
      remediation_outcome: ["merged_clean", "merged_with_edits", "rejected"],
      run_activity_phase: [
        "queued",
        "planning",
        "progress",
        "completed",
        "failed",
      ],
      run_mode: [
        "remediate",
        "assess",
        "generate",
        "review",
        "refactor",
        "remediate-refactor",
        "policygate",
        "updatedependencies",
        "modernizedeprecated",
        "costoptimization",
        "driftdetect",
        "complianceaudit",
        "summarizepr",
        "incrementalreview",
        "addressreviews",
        "resolveconflicts",
        "terraformcodereview",
      ],
      run_status: ["queued", "running", "success", "failed"],
    },
  },
} as const
