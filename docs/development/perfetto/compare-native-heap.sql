WITH checkpoints(label, endpoint_ns) AS (
  VALUES ('T0', @T0_NS@), ('T1', @T1_NS@), ('T2', @T2_NS@)
),
balances AS (
  SELECT
    checkpoints.label,
    allocation.callsite_id,
    SUM(allocation.size) AS unreleased_bytes,
    SUM(CASE WHEN allocation.size > 0 THEN allocation.size ELSE 0 END) AS total_bytes,
    SUM(allocation.count) AS unreleased_count
  FROM checkpoints
  JOIN heap_profile_allocation AS allocation ON allocation.ts <= checkpoints.endpoint_ns
  JOIN process ON process.upid = allocation.upid
  WHERE process.pid = @PID@ AND allocation.heap_name = 'libc.malloc'
  GROUP BY checkpoints.label, allocation.callsite_id
),
per_stack AS (
  SELECT
    callsite_id,
    SUM(CASE WHEN label = 'T0' THEN unreleased_bytes ELSE 0 END) AS live_t0,
    SUM(CASE WHEN label = 'T1' THEN unreleased_bytes ELSE 0 END) AS live_t1,
    SUM(CASE WHEN label = 'T2' THEN unreleased_bytes ELSE 0 END) AS live_t2,
    SUM(CASE WHEN label = 'T0' THEN total_bytes ELSE 0 END) AS total_t0,
    SUM(CASE WHEN label = 'T1' THEN total_bytes ELSE 0 END) AS total_t1,
    SUM(CASE WHEN label = 'T2' THEN total_bytes ELSE 0 END) AS total_t2,
    SUM(CASE WHEN label = 'T0' THEN unreleased_count ELSE 0 END) AS count_t0,
    SUM(CASE WHEN label = 'T1' THEN unreleased_count ELSE 0 END) AS count_t1,
    SUM(CASE WHEN label = 'T2' THEN unreleased_count ELSE 0 END) AS count_t2
  FROM balances
  GROUP BY callsite_id
)
SELECT
  per_stack.*,
  live_t1 - live_t0 AS live_block_1,
  live_t2 - live_t1 AS live_block_2,
  total_t1 - total_t0 AS total_block_1,
  total_t2 - total_t1 AS total_block_2,
  count_t1 - count_t0 AS count_block_1,
  count_t2 - count_t1 AS count_block_2,
  mapping.name AS leaf_mapping,
  COALESCE(symbol.name, frame.deobfuscated_name, frame.name) AS leaf_name,
  frame.rel_pc AS leaf_offset
FROM per_stack
LEFT JOIN stack_profile_callsite AS callsite ON callsite.id = per_stack.callsite_id
LEFT JOIN stack_profile_frame AS frame ON frame.id = callsite.frame_id
LEFT JOIN stack_profile_mapping AS mapping ON mapping.id = frame.mapping
LEFT JOIN stack_profile_symbol AS symbol ON symbol.id = frame.symbol_set_id
ORDER BY MAX(ABS(live_block_1), ABS(live_block_2)) DESC, per_stack.callsite_id;
