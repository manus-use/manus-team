/**
 * Building blocks for tests of workflows (spec §21): the example of the spec, as
 * a file, and a home's workflows directory to write files into.
 */

/** The example of spec §21.1, as written there. */
export const VENDOR_EVAL = `description: Shortlist vendors, evaluate each in parallel, then recommend one
params:
  topic:    { required: true, description: what is being bought }
  vendors:  { list: true, required: true }
  reviewer: { default: reviewer }
steps:
  shortlist:
    title: Shortlist vendors for {{topic}}
    assignee: worker
    outcome: a shortlist with one line per vendor
  evaluate:
    for_each: vendors
    parents: [shortlist]
    title: Evaluate {{item}} for {{topic}}
    assignee: worker
    gates:
      - command: test -s evaluation.md
        timeout_s: 30
  recommend:
    parents: [evaluate]
    title: Recommend a vendor for {{topic}}
    assignee: worker
    reviewer: { role: "{{reviewer}}" }
    verify: every score comes from a parent's summary
`;
