---
name: threat-model
description: "Structured threat modeling for a feature, architecture, or codebase: assets, actors, trust boundaries, abuse cases, STRIDE-style threats, controls, residual risk, and security test cases. Use before building risky features or before a security review."
disable-model-invocation: true
---

# Threat Model

Produce a threat model that developers can turn into design changes and tests. Prefer code-backed facts over generic threat lists.

## Workflow

1. **Define scope and decision.** Identify the feature/system, data assets, actors, deployment boundary, and what decision the model must support. If the request omits the asset or trust boundary and guessing would change the result, ask one scoped question.

2. **Read the system.** For an existing codebase, map the actual entry points, auth middleware, data stores, queues, third-party calls, and privileged jobs. For a planned system, use the spec or diagrams and label all assumptions.

3. **Draw the data-flow model in text.** Keep it compact:

   ```text
   actor -> entry point -> validation/authz -> service/job -> datastore/external API
   trust boundary crossings: browser->API, API->queue, queue->worker, service->vendor
   assets: session tokens, tenant data, billing actions, admin config
   ```

4. **Generate abuse cases.** Work from attacker goals, not vulnerability names. Cover at least:
   - Spoof identity or session.
   - Tamper with user, tenant, or workflow state.
   - Repudiate sensitive actions because audit data is missing or mutable.
   - Disclose secrets, personal data, tenant data, or internal topology.
   - Deny service through expensive paths or quota bypass.
   - Elevate privilege across roles, tenants, environments, or service accounts.

5. **Map controls and gaps.** For each abuse case, name the existing control and cite the file/line or spec section. If there is no control, propose the smallest design change: authz check, state invariant, input contract, output encoding, secret boundary, rate limit, audit event, or isolation boundary.

6. **Create testable security requirements.** Convert important mitigations into concrete verification tasks. Use ASVS-style phrasing when useful: "Verify that..." Each requirement should name where it is enforced and how to test it.

7. **Review residual risk.** Rank unresolved risks by likelihood and impact. Make a ship decision: acceptable, acceptable with tracked mitigations, or redesign before implementation.

## Agent use

For large systems, delegate independent slices, then merge and dedupe yourself:

```text
task security-attack-surface: map trust boundaries, roles, assets, and sensitive sinks
task security-vuln-tracer: check whether proposed controls already exist in code paths
task security-reporter: turn the merged model into a risk-ranked report
```

## Output template

```markdown
# Threat model: [system/feature]

## Scope and assumptions
- In scope:
- Out of scope:
- Assumptions:

## Data-flow model
- Actors:
- Assets:
- Trust boundaries:
- Flow:

## Abuse cases and controls
| Abuse case | Existing control | Gap | Mitigation | Security test |
| --- | --- | --- | --- | --- |

## Security requirements
- [ ] Verify that ...

## Residual risks
| Risk | Likelihood | Impact | Owner/decision |
| --- | --- | --- | --- |

## Verdict
Accept / accept with mitigations / redesign required.
```

## Done criteria

- [ ] Scope, assets, actors, and trust boundaries are explicit.
- [ ] Existing controls are cited from code or labeled as assumptions.
- [ ] Abuse cases cover identity, tampering, repudiation, disclosure, denial, and privilege escalation.
- [ ] Mitigations are minimal and testable.
- [ ] Residual risk and ship/design verdict are stated.
