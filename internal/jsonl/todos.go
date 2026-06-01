package jsonl

import (
	"encoding/json"
	"os"
)

// snapshot is one (ts, todos, keyset, isAnchor) record in the plan scan.
type snapshot struct {
	ts       float64
	todos    []Todo
	kset     map[string]struct{}
	isAnchor bool
}

// todoState accumulates plan snapshots; reused by the incremental cache.
type todoState struct {
	snapshots []snapshot
}

func newTodoState() *todoState { return &todoState{} }

func (s *todoState) clone() *todoState {
	cp := &todoState{snapshots: make([]snapshot, len(s.snapshots))}
	copy(cp.snapshots, s.snapshots)
	return cp
}

// todosKset emits BOTH id:<tid> and c:<content> keys per task so anonymous
// TaskCreate snapshots merge with the later task_reminder that assigns ids.
// (Port of _todos_kset.)
func todosKset(todos []Todo) map[string]struct{} {
	keys := map[string]struct{}{}
	for _, t := range todos {
		if id := parseID(t.ID); id != "" {
			keys["id:"+id]= struct{}{}
		}
		if t.Content != "" {
			keys["c:"+t.Content] = struct{}{}
		}
	}
	return keys
}

func ksetIntersects(a, b map[string]struct{}) bool {
	if len(a) > len(b) {
		a, b = b, a
	}
	for k := range a {
		if _, ok := b[k]; ok {
			return true
		}
	}
	return false
}

func ksetUnion(a, b map[string]struct{}) map[string]struct{} {
	out := make(map[string]struct{}, len(a)+len(b))
	for k := range a {
		out[k] = struct{}{}
	}
	for k := range b {
		out[k] = struct{}{}
	}
	return out
}

// rawTodoInput decodes a TodoWrite/TaskCreate/TaskUpdate tool_use input.
type rawTodoInput struct {
	Todos      json.RawMessage `json:"todos"`
	Subject    string          `json:"subject"`
	Description *string         `json:"description"`
	ActiveForm  *string         `json:"activeForm"`
	Status      string          `json:"status"`
	Priority    *string         `json:"priority"`
	TaskID      any             `json:"taskId"`
	ID          any             `json:"id"`
}

type rawTaskItem struct {
	ID         any     `json:"id"`
	Subject    string  `json:"subject"`
	Content    string  `json:"content"`
	Description *string `json:"description"`
	ActiveForm  *string `json:"activeForm"`
	Status      string  `json:"status"`
	Priority    *string `json:"priority"`
}

func allCompleted(todos []Todo) bool {
	if len(todos) == 0 {
		return false
	}
	for _, t := range todos {
		if t.Status != "completed" {
			return false
		}
	}
	return true
}

// feed processes one decoded line for plan snapshots. (Port of the per-line
// body of get_todo_plans.)
func (s *todoState) feed(d *rawEntry) {
	ts := parseISOTs(d.Timestamp)
	switch d.Type {
	case "assistant":
		if d.Message == nil {
			return
		}
		for _, b := range d.Message.blocks() {
			if b.Type != "tool_use" {
				continue
			}
			switch b.Name {
			case "TodoWrite":
				var inp rawTodoInput
				if err := json.Unmarshal(b.Input, &inp); err != nil {
					continue
				}
				todos := decodeTodoList(inp.Todos)
				if todos == nil {
					continue
				}
				kset := map[string]struct{}{}
				for _, x := range todos {
					if x.Content != "" {
						kset["c:"+x.Content] = struct{}{}
					}
				}
				s.snapshots = append(s.snapshots, snapshot{ts, todos, kset, true})
			case "TaskCreate":
				var inp rawTodoInput
				if err := json.Unmarshal(b.Input, &inp); err != nil {
					continue
				}
				subject := inp.Subject
				desc := inp.Description
				if subject == "" {
					if desc != nil {
						subject = *desc
					}
					desc = nil
				}
				if subject == "" {
					continue
				}
				tid := inp.TaskID
				if tid == nil {
					tid = inp.ID
				}
				newTask := Todo{ID: tid, Content: subject, Description: desc, ActiveForm: inp.ActiveForm, Status: "pending", Priority: inp.Priority}
				var prev []Todo
				if len(s.snapshots) > 0 {
					prev = s.snapshots[len(s.snapshots)-1].todos
				}
				var merged []Todo
				isAnchor := false
				if allCompleted(prev) || len(prev) == 0 {
					merged = []Todo{newTask}
					isAnchor = true
				} else {
					merged = append(append([]Todo(nil), prev...), newTask)
				}
				s.snapshots = append(s.snapshots, snapshot{ts, merged, todosKset(merged), isAnchor})
			case "TaskUpdate":
				var inp rawTodoInput
				if err := json.Unmarshal(b.Input, &inp); err != nil {
					continue
				}
				tid := inp.TaskID
				if tid == nil {
					tid = inp.ID
				}
				tidStr := parseID(tid)
				if tidStr == "" || len(s.snapshots) == 0 {
					continue
				}
				prev := s.snapshots[len(s.snapshots)-1].todos
				updated := make([]Todo, 0, len(prev))
				touched := false
				for _, x := range prev {
					if parseID(x.ID) == tidStr {
						nx := x
						if inp.Status != "" {
							nx.Status = inp.Status
						}
						if inp.Subject != "" {
							nx.Content = inp.Subject
						}
						// "description" present in input → set (even to null).
						if hasKey(b.Input, "description") {
							nx.Description = inp.Description
						}
						if inp.ActiveForm != nil {
							nx.ActiveForm = inp.ActiveForm
						}
						updated = append(updated, nx)
						touched = true
					} else {
						updated = append(updated, x)
					}
				}
				if !touched {
					continue
				}
				s.snapshots = append(s.snapshots, snapshot{ts, updated, todosKset(updated), false})
			}
		}
	case "attachment":
		if d.Attachment == nil || d.Attachment.Type != "task_reminder" {
			return
		}
		items := decodeTaskItems(d.Attachment.Content)
		var norm []Todo
		for _, it := range items {
			subject := it.Subject
			if subject == "" {
				subject = it.Content
			}
			if subject == "" {
				continue
			}
			status := it.Status
			if status == "" {
				status = "pending"
			}
			norm = append(norm, Todo{ID: it.ID, Content: subject, Description: it.Description, ActiveForm: it.ActiveForm, Status: status, Priority: it.Priority})
		}
		// ALWAYS emit, even when empty (reset signal).
		s.snapshots = append(s.snapshots, snapshot{ts, norm, todosKset(norm), true})
	}
}

func decodeTodoList(raw json.RawMessage) []Todo {
	if len(raw) == 0 {
		return nil
	}
	// May be a JSON-encoded string.
	var asStr string
	if err := json.Unmarshal(raw, &asStr); err == nil {
		raw = json.RawMessage(asStr)
	}
	var items []Todo
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil
	}
	out := make([]Todo, 0, len(items))
	for _, x := range items {
		out = append(out, x)
	}
	return out
}

func decodeTaskItems(raw json.RawMessage) []rawTaskItem {
	if len(raw) == 0 {
		return nil
	}
	var items []rawTaskItem
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil
	}
	return items
}

// hasKey reports whether a JSON object literal contains a top-level key.
func hasKey(raw json.RawMessage, key string) bool {
	if len(raw) == 0 {
		return false
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return false
	}
	_, ok := m[key]
	return ok
}

// groupPlans converts accumulated snapshots into {active, history}.
// (Port of the grouping loop in get_todo_plans.)
func (s *todoState) result() TodoPlansResult {
	type plan struct {
		todos     []Todo
		createdTs float64
		lastTs    float64
		kset      map[string]struct{}
	}
	var plans []*plan
	var lastAnchorKset map[string]struct{}

	for _, sn := range s.snapshots {
		if len(sn.todos) == 0 {
			if len(plans) > 0 && len(plans[len(plans)-1].todos) > 0 {
				plans = append(plans, &plan{todos: nil, createdTs: sn.ts, lastTs: sn.ts, kset: map[string]struct{}{}})
			}
			lastAnchorKset = nil
			continue
		}
		if sn.isAnchor {
			if lastAnchorKset != nil && !ksetIntersects(sn.kset, lastAnchorKset) {
				plans = append(plans, &plan{todos: sn.todos, createdTs: sn.ts, lastTs: sn.ts, kset: sn.kset})
				lastAnchorKset = sn.kset
				continue
			}
			lastAnchorKset = sn.kset
		}
		if len(plans) > 0 && len(plans[len(plans)-1].todos) > 0 &&
			(!sn.isAnchor || ksetIntersects(sn.kset, plans[len(plans)-1].kset)) {
			p := plans[len(plans)-1]
			p.todos = sn.todos
			p.lastTs = sn.ts
			p.kset = ksetUnion(sn.kset, p.kset)
		} else {
			plans = append(plans, &plan{todos: sn.todos, createdTs: sn.ts, lastTs: sn.ts, kset: sn.kset})
		}
	}

	// Drop sentinel reset plans.
	kept := plans[:0]
	for _, p := range plans {
		if len(p.todos) > 0 {
			kept = append(kept, p)
		}
	}
	plans = kept

	res := TodoPlansResult{Active: []Todo{}, History: []TodoPlan{}}
	if len(plans) == 0 {
		return res
	}
	for i, p := range plans {
		isLatest := i == len(plans)-1
		if isLatest && !allCompleted(p.todos) {
			res.Active = p.todos
		} else {
			res.History = append(res.History, TodoPlan{Todos: p.todos, CreatedTs: p.createdTs, CompletedTs: p.lastTs})
		}
	}
	// history.reverse()
	for i, j := 0, len(res.History)-1; i < j; i, j = i+1, j-1 {
		res.History[i], res.History[j] = res.History[j], res.History[i]
	}
	return res
}

// GetTodoPlans ports get_todo_plans (full scan).
func GetTodoPlans(claudeSessionID, cwd string) (TodoPlansResult, error) {
	jsonlPath := FindSessionJSONL(claudeSessionID, cwd)
	if jsonlPath == "" {
		return TodoPlansResult{Active: []Todo{}, History: []TodoPlan{}}, nil
	}
	return getTodoPlansPath(jsonlPath)
}

func getTodoPlansPath(jsonlPath string) (TodoPlansResult, error) {
	f, err := os.Open(jsonlPath)
	if err != nil {
		return TodoPlansResult{Active: []Todo{}, History: []TodoPlan{}}, err
	}
	defer f.Close()

	st := newTodoState()
	sc := newScanner(f)
	for sc.Scan() {
		line := sc.Bytes()
		if !containsBytes(line, "TodoWrite") && !containsBytes(line, "TaskCreate") &&
			!containsBytes(line, "TaskUpdate") && !containsBytes(line, "task_reminder") {
			continue
		}
		d, ok := decodeLine(line)
		if !ok {
			continue
		}
		st.feed(&d)
	}
	return st.result(), sc.Err()
}
