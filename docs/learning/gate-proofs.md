# Gate proofs

A gate counts only once it has been made to fail by reintroducing the defect it guards. Each entry records the gate, the mutation, the failure it produced, and the commit before the lesson was retired, so `git show <sha>:docs/learning/lessons-evidence.md` can recover the full evidence.
