Added validated `routing.bucket_excluded_models`, an exact-ID exclusion list for
bucket selection. Empty by default. Exclusions survive discovery refresh and
apply before primary and fallback selection. Existing class, provider, trust,
lifecycle, and completion-identity checks remain unchanged. Explicit concrete
model requests remain available for diagnosis. Clear the list to roll back.
