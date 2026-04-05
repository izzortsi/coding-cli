;; grove-lisp agent boot library v2
;; Self-improved through the reflective loop.
;; All variadics use & (not .), all builtins use correct arg order.

;; --- Macros ---
;; NOTE: unquote is ~ (not ,), splice-unquote is ~@ (not ,@). Clojure-style.

;; Conditional with implicit begin (no else branch)
(defmacro (when test & body)
  `(if ~test (begin ~@body) nil))

;; Negated conditional with implicit begin
(defmacro (unless test & body)
  `(if (not ~test) (begin ~@body) nil))

;; Threading macro: (-> val (f a) (g b)) → (g (f val a) b)
(defmacro (-> val & forms)
  (reduce
    (fn (acc form)
      (if (list? form)
        (cons (car form) (cons acc (cdr form)))
        (list form acc)))
    val
    forms))

;; Binding with default: (let-default ((x expr default)) body)
;; If expr is nil, uses default instead
(defmacro (let-default bindings & body)
  (let ((expanded (map (fn (b)
                         (let ((name (car b))
                               (expr (nth b 1))
                               (default (nth b 2)))
                           `(~name (let ((__tmp ~expr))
                                     (if (nil? __tmp) ~default __tmp)))))
                       bindings)))
    `(let ~expanded ~@body)))

;; --- Utility ---

(define (safe-call tool-name args)
  (try
    (tool-call tool-name args)
    (catch e
      (str "ERROR: " e))))

;; Retry a thunk up to n times; on exhaustion, errors with the last error message
(define (retry n thunk)
  (define (attempt i last-err)
    (if (<= i 0)
      (error (str "retry: all " (number->string n) " attempts failed. Last error: " last-err))
      (try (thunk)
           (catch e (attempt (- i 1) e)))))
  (attempt n ""))

;; --- File Operations ---

(define (read-file path)
  (safe-call "read_file"
    (list (list :file_path path))))

(define (search-code pattern dir)
  (safe-call "code_search"
    (list (list :patterns pattern)
          (list :paths dir))))

(define (ls dir)
  (safe-call "list_directory"
    (list (list :path dir))))

(define (directory-tree dir & opts)
  (let ((args (list (list :path dir))))
    (let ((args (if (empty? opts) args
                    (append args (list (list :ext_filter (first opts)))))))
      (safe-call "directory_tree" args))))

(define (find-files dir & opts)
  (let ((args (list (list :path dir))))
    (let ((args (if (empty? opts) args
                    (append args (list (list :name (first opts)))))))
      (safe-call "find_files" args))))

;; Search within a file, optional case-insensitive with "i" flag
(define (grep path pattern & opts)
  (let ((ci (if (empty? opts) #f (= (first opts) "i"))))
    (let ((contents (read-file path)))
      (if (str-starts? "ERROR" contents)
        contents
        (let ((pat (if ci (str-lower pattern) pattern))
              (lines (str-split "\
" contents)))
          (let ((matches (filter
                  (fn (line) (str-contains? pat (if ci (str-lower line) line)))
                  lines)))
            (if (empty? matches)
              (str "No matches for \"" pattern "\" in " path)
              (str (number->string (length matches)) " matches in " path ":\
"
                   (str-join "\
" matches)))))))))

(define (head path n)
  (let ((contents (read-file path)))
    (if (str-starts? "ERROR" contents)
      contents
      (let ((lines (str-split "\
" contents)))
        (str-join "\
" (map (fn (i) (nth lines i))
                            (range 0 (min n (length lines)))))))))

;; Last N lines of a file
(define (tail path n)
  (let ((contents (read-file path)))
    (if (str-starts? "ERROR" contents)
      contents
      (let ((lines (str-split "\
" contents)))
        (let ((total (length lines))
              (start (max 0 (- (length lines) n))))
          (str-join "\
" (map (fn (i) (nth lines i))
                            (range start total))))))))

;; Count total and non-blank lines (strips line-number prefix from read-file output)
(define (loc-count path)
  (let ((contents (read-file path)))
    (if (str-starts? "ERROR" contents)
      contents
      (let ((lines (str-split "\
" contents)))
        (let ((non-blank (filter
                (fn (line)
                  (let ((stripped (if (str-contains? " | " line)
                                   (str-join " | " (rest (str-split " | " line)))
                                   line)))
                    (not (= (str-len (str-trim stripped)) 0))))
                lines)))
          (str path ": " (number->string (length lines)) " total, "
               (number->string (length non-blank)) " non-blank"))))))

(define (multi-grep pattern dirs)
  (map (fn (dir) (list dir (search-code pattern dir))) dirs))

;; --- Write Operations ---

(define (propose-write filepath content rationale)
  (safe-call "propose_write"
    (list (list :file_path filepath)
          (list :content content)
          (list :rationale rationale))))

(define (propose-edit filepath search replace rationale)
  (safe-call "propose_edit"
    (list (list :file_path filepath)
          (list :search search)
          (list :replace replace)
          (list :rationale rationale))))

(define (propose-exec command rationale & opts)
  (let ((args (list (list :command command)
                    (list :rationale rationale))))
    (let ((args (if (empty? opts) args
                    (append args (list (list :timeout (first opts)))))))
      (safe-call "propose_exec" args))))

(define (validate-self)
  (safe-call "validate_self" (list)))

;; Multi-file atomic patch
(define (propose-patch patch-text rationale)
  (safe-call "propose_patch"
    (list (list :patch patch-text)
          (list :rationale rationale))))

;; Delegate bounded work to a subagent
(define (run-subagent agent-type prompt)
  (safe-call "run_subagent"
    (list (list :agent_type agent-type)
          (list :prompt prompt))))

;; Read file, show context around match, then propose edit
(define (safe-edit path search replace why)
  (let ((contents (read-file path)))
    (if (str-starts? "ERROR" contents)
      (str "Cannot read file: " contents)
      (if (not (str-contains? search contents))
        (str "SEARCH text not found in " path ". Read the file first to get exact content.")
        (let ((lines (str-split "\n" contents))
              (search-first (first (str-split "\n" search))))
          (let ((match-idx (reduce (fn (acc i)
                                     (if (and (= acc -1) (str-contains? search-first (nth lines i)))
                                       i acc))
                                   -1 (range 0 (length lines))))
                ;; Count full-string occurrences to match propose_edit uniqueness constraint
                (full-count (- (length (str-split search contents)) 1)))
            (if (> full-count 1)
              ;; Block multi-match edits — propose_edit would reject these anyway
              (str "❌ SEARCH text appears " (number->string full-count) " times in " path
                   ".\nUse a more specific search string that uniquely identifies the location.\n"
                   "Tip: include more surrounding context lines in the search string.")
              (let ((context (if (= match-idx -1)
                               "Could not locate exact line for context.\n"
                               (let ((start (max 0 (- match-idx 2)))
                                     (end (min (+ match-idx 5) (length lines))))
                                 (str "--- Context at match (line " (number->string (+ match-idx 1)) ") ---\n"
                                      (str-join "\n"
                                        (map (fn (i)
                                               (let ((marker (if (and (>= i match-idx) (< i (+ match-idx 3))) ">>" "  ")))
                                                 (str marker " " (number->string (+ i 1)) " | " (nth lines i))))
                                             (range start end)))
                                      "\n")))))
                (str context
                     "--- Staging edit ---\n"
                     (propose-edit path search replace why))))))))))

(define (test-edit path search replace why)
  (let ((edit-result (safe-edit path search replace why)))
    (if (str-starts? "ERROR" edit-result)
      edit-result
      (let ((check (validate-self)))
        (str edit-result "\
\
--- Validation ---\
" check)))))

;; --- Reflection ---

(define (analyze prompt data)
  (llm-reflect
    (str prompt "\
\
Data:\
" (if (string? data) data (print data)))
    data))

;; Improve a strategy — includes builtin conventions so LLM generates correct code
(define (improve-strategy name goal)
  (let ((form (inspect name))
        (src (print (inspect name))))
    (let ((prompt (str "Improve this Lisp function to better achieve the goal.\
"
                       "Goal: " goal "\
\
"
                       "Current definition:\
" src "\
\
"
                       "RULES:\
"
                       "- Return ONLY the improved (define ...) form\
"
                       "- No explanation, no markdown, no code fences\
"
                       "- Use & for variadic params: (define (f x & rest) ...)\
"
                       "- str-split is (separator string): (str-split \"\\
\" contents)\
"
                       "- str-contains? is (needle haystack): (str-contains? \"foo\" line)\
"
                       "- str-starts? is (prefix string): (str-starts? \"ERROR\" msg)\
"
                       "- str-ends? is (suffix string): (str-ends? \".ts\" path)\
"
                       "- Available: str, str-split, str-join, str-contains?, str-starts?, str-ends?, str-trim, str-len, str-lower, str-upper\
"
                       "- Available: length, list, cons, car, cdr, first, rest, nth, append, reverse, range, flatten\
"
                       "- Available: map, filter, reduce, apply, for-each\
"
                       "- Available: +, -, *, /, =, <, >, <=, >=, not, and, or, mod, abs, min, max\
"
                       "- Available: number->string, string->number, symbol->string, string->symbol")))
      (llm-reflect prompt))))

(define (show-strategies)
  (let ((names (strategies)))
    (map (fn (name) (list name (source name))) names)))

;; --- LLM-Powered Analysis ---

(define (file-summary path)
  (let ((contents (read-file path)))
    (if (str-starts? "ERROR" contents)
      contents
      (llm-reflect
        (str "Summarize this file in 2-3 sentences. What is its purpose, key exports, and role in the system?\
\
File: " path "\
\
" contents)))))

(define (find-todos dir)
  (let ((todos (search-code "TODO" dir))
        (fixmes (search-code "FIXME" dir))
        (hacks (search-code "HACK" dir)))
    (str "=== TODOs ===\
" todos "\
\
=== FIXMEs ===\
" fixmes "\
\
=== HACKs ===\
" hacks)))

(define (trace-imports path)
  (let ((contents (read-file path))
        ;; last element of path split = basename (was buggy: car/rest/reverse gave parent dir)
        (basename (last (str-split "/" path))))
    (let ((importers (search-code basename ".")))
      (str "=== File: " path " ===\n\n"
           "--- What it imports (from source) ---\n"
           (llm-reflect (str "List only the import lines from this file, one per line. No explanation.\n\n" contents))
           "\n\n--- What imports it ---\n"
           importers))))

(define (review-file path)
  (let ((contents (read-file path)))
    (if (str-starts? "ERROR" contents)
      contents
      (llm-reflect
        (str "Review this code. Identify:\
"
             "1. Bugs or potential issues\
"
             "2. Performance concerns\
"
             "3. Missing error handling\
"
             "4. Suggestions for improvement\
\
"
             "Be specific — reference line numbers. Keep it concise.\
\
"
             "File: " path "\
\
" contents)))))

(define (explain name)
  (let ((form (inspect name)))
    (if (nil? form)
      (str "Strategy not found: " name)
      (llm-reflect
        (str "Explain what this Lisp strategy does, how it works, and when to use it.\n"
             "Keep it under 100 words.\n\n"
             "Name: " name "\n"
             "Source: " (source name))))))

(define (scan-dir dir)
  (let ((tree (directory-tree dir))
        (summary (llm-reflect
          (str "Given this directory tree, identify:\
"
               "1. What this directory/module is for (1 sentence)\
"
               "2. The key entry point files\
"
               "3. The dependency structure\
"
               "Keep it under 150 words.\
\
" tree))))
    (str "=== " dir " ===\
" tree "\
\
" summary)))

(define (batch-summary dir ext)
  ;; Use find-files for full relative paths — directory-tree only shows filenames
  (let ((files (filter (fn (f) (not (= (str-trim f) "")))
                       (str-split "\n" (find-files dir (str "*." ext))))))
    (map (fn (path)
           (list path (try (file-summary path) (catch e (str "[error: " e "]")))))
         files)))

;; --- Strategy Versioning ---

(define strategy-history (list))

(define (save-version name)
  (let ((current (inspect name)))
    (if (nil? current)
      (str "Strategy not found: " name)
      (begin
        (set! strategy-history
          (cons (list name (number->string (length strategy-history)) current)
                strategy-history))
        (str "Saved version " (number->string (- (length strategy-history) 1)) " of " name)))))

(define (rollback name)
  (let ((versions (filter (fn (entry) (= (first entry) name)) strategy-history)))
    (if (empty? versions)
      (str "No saved versions for: " name)
      (let ((latest (first versions)))
        (eval (nth latest 2))
        (str "Rolled back " name " to saved version")))))

;; --- Composition ---

(define (pipeline val & fns)
  (reduce (fn (acc f) (f acc)) val fns))

(define (fan-out val & fns)
  (map (fn (f) (f val)) fns))

;; Try each thunk in order, return first success; error with last error if all fail
(define (first-success & thunks)
  (define (try-all remaining last-err)
    (if (empty? remaining)
      (error (str "first-success: all strategies failed. Last error: " last-err))
      (try ((first remaining))
           (catch e (try-all (rest remaining) e)))))
  (if (empty? thunks)
    (error "first-success: no strategies provided")
    (try-all thunks "")))

;; --- Functional Primitives ---

;; Check if list (or nil) is empty
(define (empty? lst)
  (or (nil? lst) (and (list? lst) (= 0 (length lst)))))

;; List accessors — Lisp fallbacks (native builtins take precedence after rebuild)
(define (second lst) (nth lst 1))
(define (third lst) (nth lst 2))
(define (last lst)
  (if (empty? lst) nil
    (if (empty? (cdr lst)) (car lst)
      (last (cdr lst)))))

;; String operations — Lisp fallbacks matching native builtins.ts argument order
;; (str-replace s target replacement) — replace all occurrences of target in s
(define (str-replace s target replacement)
  (if (= (str-len target) 0) s
    (let ((parts (str-split target s)))
      (str-join replacement parts))))

;; (str-index-of substr s) → index of substr in s, or -1
(define (str-index-of substr s)
  (let ((hlen (str-len s))
        (nlen (str-len substr)))
    (if (= nlen 0) 0
      (let ((loop (fn (i)
                    (if (> (+ i nlen) hlen) -1
                      (if (= (substring s i (+ i nlen)) substr) i
                        (loop (+ i 1)))))))
        (loop 0)))))

;; Do all elements satisfy predicate?
(define (every? pred lst)
  (if (empty? lst) #t
    (if (not (pred (car lst))) #f
      (every? pred (cdr lst)))))

;; Does any element satisfy predicate?
(define (some? pred lst)
  (if (empty? lst) #f
    (if (pred (car lst)) #t
      (some? pred (cdr lst)))))

;; Combine two lists pairwise: (zip '(1 2) '(a b)) → ((1 a) (2 b))
(define (zip a b)
  (if (or (empty? a) (empty? b)) (list)
    (cons (list (car a) (car b))
          (zip (cdr a) (cdr b)))))

;; Map then flatten one level
(define (flat-map f lst)
  (reduce append (list) (map f lst)))

;; First n elements
(define (take n lst)
  (if (or (<= n 0) (empty? lst)) (list)
    (cons (car lst) (take (- n 1) (cdr lst)))))

;; Skip first n elements
(define (drop n lst)
  (if (or (<= n 0) (empty? lst)) lst
    (drop (- n 1) (cdr lst))))

;; Pipeline with nil short-circuit and error catching
(define (pipeline-safe val & fns)
  (reduce
    (fn (acc f)
      (if (nil? acc) nil
        (try (f acc) (catch e (str "Pipeline error: " e)))))
    val fns))

;; compose is a builtin (async-safe, multi-arg)
;; pipe is a builtin (like pipeline but native, async-safe)
;; identity and constantly are builtins

;; Partial application
(define (partial f & bound-args)
  (fn (& rest-args)
    (apply f (append bound-args rest-args))))

;; --- Extended Functional Utilities ---

;; Find first element matching predicate, or nil
(define (find-first pred lst)
  (if (empty? lst) nil
    (if (pred (first lst)) (first lst)
      (find-first pred (rest lst)))))

;; Take elements while predicate holds
(define (take-while pred lst)
  (if (empty? lst) (list)
    (if (pred (first lst))
      (cons (first lst) (take-while pred (rest lst)))
      (list))))

;; Drop elements while predicate holds
(define (drop-while pred lst)
  (if (empty? lst) (list)
    (if (pred (first lst)) (drop-while pred (rest lst))
      lst)))

;; Count non-overlapping occurrences of pattern in string
(define (count-matches pattern string)
  (let ((len (str-len string))
        (pat-len (str-len pattern)))
    (if (= pat-len 0) 0
      (let ((loop (fn (pos acc)
                    (if (> (+ pos pat-len) len) acc
                      (let ((found (= (substring string pos (+ pos pat-len)) pattern)))
                        (loop (+ pos 1) (if found (+ acc 1) acc)))))))
        (loop 0 0)))))

;; Group list elements by key function → list of (key elements) pairs
(define (group-by key-fn lst)
  (if (empty? lst) (list)
    (let ((key (key-fn (first lst))))
      (cons (list key (filter (fn (x) (= (key-fn x) key)) lst))
            (group-by key-fn (filter (fn (x) (not (= (key-fn x) key))) lst))))))

;; Remove duplicate elements (keeps first occurrence)
(define (distinct lst)
  (if (empty? lst) (list)
    (cons (first lst)
          (distinct (filter (fn (x) (not (= x (first lst)))) (rest lst))))))

;; mapcat: map then concatenate (alias for flat-map)
(define (mapcat f lst) (flat-map f lst))

;; Interleave two lists: (interleave '(1 2) '(a b)) → (1 a 2 b)
(define (interleave a b)
  (if (empty? a) b
    (if (empty? b) a
      (cons (first a) (interleave b (rest a))))))

;; --- Self-Improvement ---

;; Improve a strategy via LLM, with retry on failure (up to 3 attempts)
;; Guards: save-version failure, rollback failure, empty/identical output, error truncation
(define (evolve name goal & opts)
  (let ((test-expr (if (empty? opts) #f (first opts)))
        (max-attempts 3))
    (let ((save-result (try (save-version name) (catch e (str "Cannot save version: " e)))))
      (if (and (string? save-result) (str-starts? "Cannot" save-result))
        save-result
        (begin
          (define (try-evolve attempt last-err last-source)
            (if (> attempt max-attempts)
              (begin
                (try (rollback name) (catch re nil))
                (str "FAILED after " (number->string max-attempts) " attempts. Rolled back.\nLast error: " last-err))
              (let ((g (if last-err
                         (str goal "\n\nPrevious attempt failed: "
                              (if (> (str-len last-err) 500)
                                (substring last-err 0 500)
                                last-err)
                              "\nTry a different approach.")
                         goal)))
                (let ((new-source (improve-strategy name g)))
                  (if (or (nil? new-source) (= "" new-source))
                    (try-evolve (+ attempt 1) "improve-strategy returned empty source" last-source)
                    (if (and last-source (= new-source last-source))
                      (try-evolve (+ attempt 1) "Generated identical code. Try a fundamentally different approach." last-source)
                      (let ((install-result (try
                                              (tool-call "lisp_eval" (list (list "expression" new-source)))
                                              (catch e (str "Install failed: " e)))))
                        (if (and (string? install-result) (str-starts? "Install failed" install-result))
                          (try-evolve (+ attempt 1) install-result new-source)
                          (if test-expr
                            (let ((test-result (try (eval test-expr) (catch e (str "FAIL: " e)))))
                              (if (and (string? test-result) (str-starts? "FAIL" test-result))
                                (try-evolve (+ attempt 1) test-result new-source)
                                (str "Evolved " name " in " (number->string attempt) " attempt(s). Test passed.")))
                            (str "Evolved " name " in " (number->string attempt) " attempt(s). No test provided."))))))))))
          (try-evolve 1 #f #f))))))

;; Goal-directed autonomous self-improvement
(define (meta-evolve goal max-rounds)
  (let ((plan-str (llm-reflect
          (str "Goal: " goal "\
\
"
               "Available strategies: " (str-join ", " (strategies)) "\
\
"
               "Create an improvement plan: a list of 3-" (number->string max-rounds) " steps.\
"
               "Each step is ONE LINE in format: strategy-name | sub-goal | test-expression\
"
               "Use existing strategy names to improve, or NEW:name for new strategies.\
"
               "Test expressions must be valid Lisp that returns #t on success.\
"
               "Return ONLY the lines, no explanation."))))
    (let ((steps (filter (fn (line) (str-contains? "|" line))
                         (str-split "\
" plan-str))))
      (reduce
        (fn (acc step)
          (let ((parts (map str-trim (str-split "|" step))))
            (if (< (length parts) 3)
              (append acc (list (str "SKIP: malformed step: " step)))
              (let ((name (nth parts 0))
                    (sub-goal (nth parts 1))
                    (test-expr (nth parts 2)))
                (let ((result (try
                        (evolve name sub-goal test-expr)
                        (catch e (str "FAILED: " e)))))
                  (append acc (list (str "Step: " step "\
Result: " result "\
"))))))))
        (list)
        steps))))

;; Refactor a strategy toward a goal, with rollback on install failure
(define (refactor name goal)
  (begin
    (save-version name)
    (let ((new-src (improve-strategy name (str "Refactor: " goal "\nKeep the same function signature.\nMake it simpler, shorter, or more robust."))))
      (try
        (let ((install (tool-call "lisp_eval" (list (list :expression new-src)))))
          (let ((test-result (self-test)))
            (str "Refactored " name ".\n\nNew source:\n" new-src "\n\nTests: " test-result)))
        (catch e
          (rollback name)
          (str "Install failed, rolled back: " e "\n\nCode was:\n" new-src))))))

;; --- Agent Memory ---
;; Append-only log that persists across sessions via channel.lispState.
;; Categories: origin, architecture, bug-fixed, evolution, session, decision, discovery

(define agent-memory (list))

(define (remember category note)
  (set! agent-memory (append agent-memory (list (list category note))))
  (str "Remembered [" category "]: " note))

(define (recall category)
  (let ((matches (filter (fn (entry) (= (first entry) category)) agent-memory)))
    (if (empty? matches)
      (str "No memories in category: " category)
      (str-join "\
" (map (fn (m) (str "• " (nth m 1))) matches)))))

(define (recall-all)
  (if (empty? agent-memory)
    "No memories yet."
    (str-join "\
" (map (fn (m)
      (str "[" (first m) "] " (nth m 1)))
      agent-memory))))

(define (journal summary)
  (remember "session" summary))

;; Forget all memories in a category
(define (forget-category cat)
  (let ((before (length agent-memory)))
    (set! agent-memory (filter (fn (m) (not (= (first m) cat))) agent-memory))
    (str "Forgot " (number->string (- before (length agent-memory))) " memories in category '" cat "'. "
         (number->string (length agent-memory)) " remaining.")))

;; Forget memories matching a needle in their text
(define (forget needle)
  (let ((before (length agent-memory)))
    (set! agent-memory (filter (fn (m) (not (str-contains? needle (nth m 1)))) agent-memory))
    (str "Forgot " (number->string (- before (length agent-memory))) " memories matching '" needle "'. "
         (number->string (length agent-memory)) " remaining.")))

;; --- Dataset Persistence ---
;; File-backed structured data stored in ~/.grove-cli/datasets/
;; Each dataset is a JSON file. Data round-trips through sexp<->json.

(define dataset-dir
  (fn () (grove-data-dir)))

(define (dataset-path name)
  (str (dataset-dir) "/" name ".json"))

(define (save-dataset name data)
  "Save a dataset (any sexp) to disk as JSON."
  (let ((result (file-write (dataset-path name) (sexp->json data 2))))
    (if (str-starts? "Error" result)
      result
      (str "Dataset '" name "' saved."))))

(define (load-dataset name)
  "Load a dataset from disk. Returns the sexp or error string."
  (let ((path (dataset-path name)))
    (if (not (file-exists? path))
      (str "Error: Dataset '" name "' not found.")
      (let ((raw (file-read path)))
        (if (str-starts? "Error" raw)
          raw
          (json->sexp raw))))))

(define (list-datasets)
  "List all saved datasets with name and size."
  (let* ((entries (file-list (dataset-dir)))
         (json-files (filter (fn (f) (str-ends? ".json" f)) entries)))
    (if (empty? json-files)
      "No datasets found."
      (map (fn (f)
             (let* ((name (substring f 0 (- (length f) 5)))
                    (stat (file-stat (str (dataset-dir) "/" f)))
                    (size-kb (/ (second (assoc :size stat)) 1024.0))
                    (size-str (str (str-trim (number->string size-kb)) "KB")))
               (str name " (" size-str ")")))
           json-files))))

(define (delete-dataset name)
  "Delete a dataset from disk."
  (let ((result (file-delete (dataset-path name))))
    (if (str-starts? "Error" result)
      result
      (str "Dataset '" name "' deleted."))))

(define (dataset-exists? name)
  "Check if a dataset exists."
  (file-exists? (dataset-path name)))

(define (dataset-append name entry)
  "Append an entry to an existing dataset (treating it as a list). Creates if missing."
  (let ((existing (if (dataset-exists? name)
                      (load-dataset name)
                      (list))))
    (if (str-starts? "Error" existing)
      existing
      (save-dataset name (append existing (list entry))))))

(define (dataset-query name pred-fn)
  "Load a dataset and filter entries with pred-fn."
  (let ((data (load-dataset name)))
    (if (str-starts? "Error" data)
      data
      (filter pred-fn data))))

(define (dataset-keys name)
  "Return top-level keys if dataset is an alist."
  (let ((data (load-dataset name)))
    (if (str-starts? "Error" data)
      data
      (map first data))))

(define (dataset-count name)
  "Return number of entries in a dataset."
  (let ((data (load-dataset name)))
    (if (str-starts? "Error" data)
      data
      (length data))))

(define (dataset-merge name other-name)
  "Merge another dataset into this one (alist union: other wins on key conflicts)."
  (let ((a (load-dataset name))
        (b (load-dataset other-name)))
    (if (or (str-starts? "Error" a) (str-starts? "Error" b))
      (str "Error: Could not load datasets for merging.")
      (let* ((a-keys (map first a))
             (b-only (filter (fn (entry) (not (some? (fn (k) (= k (first entry))) a-keys))) b))
             (merged (append a b-only)))
        (save-dataset name merged)))))

(define (dataset-upsert name key value)
  "Insert or update a key-value pair in an alist dataset. Creates if missing."
  (let ((data (if (dataset-exists? name)
                  (load-dataset name)
                  (list))))
    (if (str-starts? "Error" data)
      data
      (let* ((without-key (filter (fn (entry) (not (= (first entry) key))) data))
             (updated (append without-key (list (list key value)))))
        (save-dataset name updated)))))

;; --- Dataset Persistence ---
;; File-backed structured storage. Datasets are stored as JSON in ~/.grove-cli/datasets/.
;; Each dataset is a named collection of entries — lists, alists, or flat values.
;; Survives across sessions, shareable across channels.

(define (dataset-dir)
  (grove-data-dir))

(define (dataset-path name)
  (str (dataset-dir) "/" name ".json"))

;; Save a dataset: (save-dataset "my-data" data)
;; data can be any sexp — gets serialized to JSON
(define (save-dataset name data)
  (let ((result (file-write (dataset-path name) (sexp->json data 2))))
    (if (str-starts? "Error" result)
      (str "save-dataset failed: " result)
      (str "Saved dataset '" name "'"))))

;; Load a dataset: (load-dataset "my-data") → sexp or error string
(define (load-dataset name)
  (let ((result (file-read (dataset-path name))))
    (if (str-starts? "Error" result)
      (str "load-dataset failed: " result)
      (try (json->sexp result)
           (catch e (str "load-dataset: invalid JSON in " name ": " e))))))

;; List all datasets with metadata
(define (list-datasets)
  (let ((entries (file-list-dir (dataset-dir))))
    (if (str-starts? "Error" entries)
      (if (str-contains? "ENOENT" entries)
        "No datasets yet. Use (save-dataset name data) to create one."
        (str "Error listing datasets: " entries))
      (let ((datasets (filter (fn (e) (str-ends? ".json" (first e))) entries)))
        (if (empty? datasets)
          "No datasets yet."
          (str-join "\n"
            (map (fn (e)
                   (let ((name (str-trim (substring (first e) 0 (- (str-len (first e)) 5))))
                         (stat (file-stat (str (dataset-dir) "/" (first e)))))
                     (if (str-starts? "Error" stat)
                       (str "  " name)
                       (let ((size (str (number->string (/ (number->string (second (first stat))) 1024)) " KB"))
                             ;; stat returns ((:size N) (:modified N) (:is-directory b) (:is-file b))
                             (raw-size (first (filter (fn (p) (= (first (first p)) :size)) stat))))
                         (str "  " name " — " (number->string (second raw-size)) " bytes"))))
                 datasets))))))))

;; Delete a dataset: (delete-dataset "my-data")
(define (delete-dataset name)
  (let ((result (file-delete (dataset-path name))))
    (if (str-starts? "Error" result)
      (str "delete-dataset failed: " result)
      (str "Deleted dataset '" name "'"))))

;; Append an entry to a dataset (list-based): (dataset-append "my-data" entry)
;; Loads, conses entry onto front, saves
(define (dataset-append name entry)
  (let ((existing (load-dataset name)))
    (if (str-starts? "Error" existing)
      ;; New dataset — wrap entry in a list
      (save-dataset name (list entry))
      (save-dataset name (cons entry existing)))))

;; Query a dataset with a predicate function: (dataset-query "my-data" (fn (x) ...))
(define (dataset-query name pred-fn)
  (let ((data (load-dataset name)))
    (if (str-starts? "Error" data)
      data
      (let ((results (filter pred-fn data)))
        (if (empty? results)
          (str "No matches in dataset '" name "'")
          results)))))

;; Get all keys from a dataset (alist-based): (dataset-keys "my-data")
(define (dataset-keys name)
  (let ((data (load-dataset name)))
    (if (str-starts? "Error" data)
      data
      (keys data))))

;; Get entry count: (dataset-count "my-data")
(define (dataset-count name)
  (let ((data (load-dataset name)))
    (if (str-starts? "Error" data)
      data
      (if (list? data) (length data) 1))))

;; Merge two datasets: (dataset-merge "target" "source")
;; Loads both, appends source entries to target, saves
(define (dataset-merge target-name source-name)
  (let ((target (load-dataset target-name))
        (source (load-dataset source-name)))
    (cond
      ((str-starts? "Error" target) target)
      ((str-starts? "Error" source) source)
      ((and (list? target) (list? source))
       (save-dataset target-name (append source target)))
      (#t (str "Cannot merge — both datasets must be lists")))))

;; Paginated dataset entries: (dataset-entries "my-data" :limit 10 :offset 0)
(define (dataset-entries name & opts)
  (let ((data (load-dataset name)))
    (if (str-starts? "Error" data)
      data
      (if (not (list? data))
        (list data)
        (let ((limit (if (empty? opts) (length data) (first opts)))
              (offset (if (< (length opts) 2) 0 (nth opts 1))))
          (take limit (drop offset data)))))))

;; ============================================================
;; --- Structured Memory System ---
;; Persistent, searchable, linkable memory with dataset backend.
;;
;; Each memory is an alist:
;;   :id    — unique ID (m1, m2, ...)
;;   :cat   — category (fact, decision, pattern, todo, journal, learned, project, ...)
;;   :text  — the memory content
;;   :tags  — list of string tags for cross-cutting concerns
;;   :ts    — epoch timestamp (milliseconds)
;;   :links — list of related memory IDs
;;
;; Usage:
;;   (mem "fact" "some insight")                — basic memory
;;   (mem "decision" "chose X over Y" '("arch")) — with tags
;;   (mem-search "keyword")                     — full-text search
;;   (mem-by-cat "fact")                        — filter by category
;;   (mem-by-tag "arch")                        — filter by tag
;;   (mem-get "m3")                             — get by ID
;;   (mem-ls)                                   — list all
;;   (mem-link! "m3" "m1")                      — link memories
;;   (mem-update! "m3" :text "new text")        — update a field
;;   (mem-delete! "m3")                         — delete by ID
;;   (mem-restore-counter!)                     — restore ID counter from store
;; ============================================================

;; Global counter for unique IDs
(define mem-id-counter 0)

;; Generate next unique memory ID
(define (mem-next-id)
  (begin
    (set! mem-id-counter (+ mem-id-counter 1))
    (str "m" (number->string mem-id-counter))))

;; Dataset name for the memory store
(define mem-store "memory-store")

;; Get epoch timestamp via file-stat on a probe file
(define (mem-timestamp)
  (let ((tmp-path (str (grove-data-dir) "/.ts-probe")))
    (begin
      (file-write tmp-path "t")
      (let ((stat (file-stat tmp-path)))
        (begin
          (file-delete tmp-path)
          (assoc :modified stat))))))

;; Create a memory record (alist)
(define (mem-create category text tags)
  (let ((id (mem-next-id)))
    (let ((ts (mem-timestamp)))
      (list
        (list :id id)
        (list :cat category)
        (list :text text)
        (list :tags tags)
        (list :ts ts)
        (list :links (list))))))

;; Save a memory to the persistent store
(define (mem-save! mem)
  (let ((existing (load-dataset mem-store)))
    (if (string? existing)
      (save-dataset mem-store (list mem))
      (save-dataset mem-store (append existing (list mem))))))

;; High-level: create and persist a memory
;; (mem "category" "text")  or  (mem "category" "text" '("tag1" "tag2"))
(define (mem category text & tag-args)
  (let ((tags (if (empty? tag-args) (list) (first tag-args))))
    (let ((record (mem-create category text tags)))
      (begin
        (mem-save! record)
        (str "✓ " (assoc :id record) " [" category "] " text)))))

;; --- Query & Search ---

;; Get all memories from the store
(define (mem-all)
  (let ((data (load-dataset mem-store)))
    (if (string? data) (list) data)))

;; Count total memories
(define (mem-count)
  (length (mem-all)))

;; Get a single memory by ID
(define (mem-get id)
  (let ((results (filter (fn (m) (= (assoc :id m) id)) (mem-all))))
    (if (empty? results) #f (first results))))

;; Search memories by substring match on text
(define (mem-search needle)
  (filter
    (fn (m) (str-contains? needle (assoc :text m)))
    (mem-all)))

;; Filter by category
(define (mem-by-cat category)
  (filter
    (fn (m) (= (assoc :cat m) category))
    (mem-all)))

;; Filter by tag
(define (mem-by-tag tag)
  (filter
    (fn (m)
      (let ((tags (assoc :tags m)))
        (if (list? tags)
          (some? (fn (t) (= t tag)) tags)
          #f)))
    (mem-all)))

;; --- Display & Formatting ---

;; Format a single memory for display
(define (mem-fmt m)
  (let ((id (assoc :id m)))
    (let ((cat (assoc :cat m)))
      (let ((text (assoc :text m)))
        (let ((tags (assoc :tags m)))
          (let ((links (assoc :links m)))
            (str id " [" cat "]"
                 (if (and (list? tags) (not (empty? tags)))
                   (str " #" (str-join " #" tags))
                   "")
                 " " text
                 (if (and (list? links) (not (empty? links)))
                   (str " → " (str-join "," links))
                   ""))))))))

;; Display a list of memories as formatted text
(define (mem-show memories)
  (if (empty? memories)
    "No memories found."
    (str-join "\n" (map mem-fmt memories))))

;; List all memories
(define (mem-ls)
  (mem-show (mem-all)))

;; List memories by category
(define (mem-ls-cat category)
  (mem-show (mem-by-cat category)))

;; --- Mutations ---

;; Update a field on a memory by ID
(define (mem-update! id field value)
  (let ((all (mem-all)))
    (let ((updated (map
      (fn (m)
        (if (= (assoc :id m) id)
          (let ((without (filter (fn (pair) (not (= (first pair) field))) m)))
            (append without (list (list field value))))
          m))
      all)))
      (begin
        (save-dataset mem-store updated)
        (str "✓ Updated " id " " (str field))))))

;; Link two memories (from → to)
(define (mem-link! from-id to-id)
  (let ((m (mem-get from-id)))
    (if (not m)
      (str "Memory " from-id " not found")
      (let ((current-links (assoc :links m)))
        (let ((new-links (if (list? current-links)
                           (if (some? (fn (l) (= l to-id)) current-links)
                             current-links
                             (append current-links (list to-id)))
                           (list to-id))))
          (mem-update! from-id :links new-links))))))

;; Delete a memory by ID
(define (mem-delete! id)
  (let ((all (mem-all)))
    (let ((remaining (filter (fn (m) (not (= (assoc :id m) id))) all)))
      (begin
        (save-dataset mem-store remaining)
        (str "✓ Deleted " id ". " (number->string (length remaining)) " remaining.")))))

;; Delete all memories in a category
(define (mem-delete-cat! category)
  (let ((all (mem-all)))
    (let ((remaining (filter (fn (m) (not (= (assoc :cat m) category))) all)))
      (begin
        (save-dataset mem-store remaining)
        (str "✓ Deleted " (number->string (- (length all) (length remaining)))
             " in [" category "]. "
             (number->string (length remaining)) " remaining.")))))

;; --- Session Management ---

;; Restore the ID counter from existing memories (call on session start)
(define (mem-restore-counter!)
  (let ((all (mem-all)))
    (if (empty? all)
      (begin (set! mem-id-counter 0) "Counter at 0")
      (let ((max-id (reduce
        (fn (acc m)
          (let ((id-str (assoc :id m)))
            (let ((num (string->number (substring id-str 1 (+ 1 (length id-str))))))
              (if (> num acc) num acc))))
        0
        all)))
        (begin
          (set! mem-id-counter max-id)
          (str "Counter restored to " (number->string max-id)))))))

;; --- Guards & Diffing ---

;; Wrap an action in test-verify-rollback: pre-check, action, post-check, auto-rollback on failure
(define (guard test-fn action-fn rollback-fn)
  (let ((before (test-fn)))
    (if (str-starts? "FAIL" before)
      (str "Pre-check failed, aborting: " before)
      (begin
        (action-fn)
        (let ((after (test-fn)))
          (if (str-starts? "FAIL" after)
            (begin
              (rollback-fn)
              (str "Action broke tests — rolled back.\nBefore: " before "\nAfter: " after))
            (str "Action succeeded. Tests pass.\nResult: " after)))))))

;; Compare current vs saved version of a strategy using LLM analysis
(define (diff-strategy name)
  (let ((current (print (inspect name)))
        (history strategy-history))
    (let ((saved (filter (fn (entry) (= (first entry) name)) history)))
      (if (empty? saved)
        (str "No saved versions of " name)
        (let ((prev (print (nth (first saved) 2))))
          (analyze
            (str "Compare these two versions of the '" name "' strategy.\n"
                 "Show what changed and whether the changes are improvements.\n\n"
                 "PREVIOUS:\n" prev "\n\n"
                 "CURRENT:\n" current)
            ""))))))

;; --- Meta-Strategies (Diagnosis & Refactoring) ---

;; Deep analysis of a strategy for weaknesses and improvements
(define (diagnose name)
  (let ((src (source name))
        (form (inspect name)))
    (llm-reflect
      (str "Analyze this Lisp strategy for weaknesses, edge cases, and improvement opportunities.\n\n"
           "Strategy name: " name "\n"
           "Source:\n```\n" src "\n```\n\n"
           "Provide:\n1. What it does (1 sentence)\n2. Edge cases that could break it\n3. Missing error handling\n4. Performance concerns\n5. Concrete improvement suggestions\n\n"
           "Be specific and actionable."))))

;; Diagnose a strategy, generate improved version, install it
;; Diagnose a strategy, improve it via LLM, install it, run self-test, rollback on failure
(define (auto-improve name)
  (let ((diagnosis (diagnose name)))
    (save-version name)
    (let ((new-src (improve-strategy name (str "Fix the issues found in this diagnosis:\n" diagnosis))))
      (try
        (let ((install (tool-call "lisp_eval" (list (list :expression new-src)))))
          (let ((test-result (self-test)))
            (str "Auto-improved " name ".\n\nDiagnosis:\n" diagnosis
                 "\n\nNew source:\n" new-src
                 "\n\nTests: " test-result)))
        (catch e
          (rollback name)
          (str "Install failed, rolled back: " e "\n\nDiagnosis was:\n" diagnosis "\n\nCode was:\n" new-src))))))

;; Comprehensive module audit — structure, summaries, architecture analysis
(define (audit-module dir)
  (let ((tree (directory-tree dir))
        ;; Use find-files for full relative paths (directory-tree only shows filenames)
        (ts-files (str-split "\n" (find-files dir "*.ts")))
        (lisp-files (str-split "\n" (find-files dir "*.lisp")))
        (all-files (filter (fn (f) (not (= (str-trim f) "")))
                           (append ts-files lisp-files))))
    (let ((summaries (map (fn (path)
                            (try
                              (str "- " path " (" (loc-count path) "): " (file-summary path))
                              (catch e (str "- " path ": [error: " e "]"))))
                          all-files)))
      (let ((report (str "# Module Audit: " dir "\n\n## Structure\n" tree
                         "\n\n## File Summaries\n" (str-join "\n" summaries))))
        (str report "\n\n## Analysis\n"
             (llm-reflect (str "Analyze this module for architectural issues, coupling, cohesion, and improvement opportunities:\n\n" report)))))))

;; Generate concrete refactoring plan from module audit
(define (refactor-plan dir goal)
  (let ((audit (audit-module dir)))
    (llm-reflect
      (str "Based on this module audit, create a concrete refactoring plan.\n\n"
           "Goal: " goal "\n\n"
           audit "\n\n"
           "For each step:\n"
           "1. Which file(s) to change\n"
           "2. What to change (specific, not vague)\n"
           "3. Why (what problem it solves)\n"
           "4. Risk level (low/medium/high)\n"
           "5. How to verify the change works\n\n"
           "Order steps by dependency (do prerequisites first)."))))

;; --- Status ---

;; Comprehensive agent status report
(define (status)
  (let ((strat-count (length (strategies)))
        (mcount (mem-count))
        (all (mem-all))
        (categories (distinct (map (fn (m) (assoc :cat m)) all))))
    (str "=== Grove Agent Status ===\n"
         "Strategies: " (number->string strat-count) "\n"
         "Memories: " (number->string mcount)
         " across " (number->string (length categories))
         " categories: " (str-join ", " categories) "\n"
         "Self-test: " (self-test))))

;; --- Self-Teaching ---

;; Examine a source file and extract lessons into persistent memory
(define (learn-from path)
  (let ((contents (read-file path))
        (summary (file-summary path)))
    (let ((lessons (llm-reflect
            (str "You are a self-improving agent examining your own source code.\n"
                 "File: " path "\n"
                 "Summary: " summary "\n\n"
                 "Content:\n" contents "\n\n"
                 "Extract 3-5 concrete lessons about:\n"
                 "1. Patterns used that could apply elsewhere\n"
                 "2. Conventions to follow consistently\n"
                 "3. Bugs or anti-patterns to avoid\n"
                 "4. Capabilities discovered that the agent should remember\n\n"
                 "Format each as a single actionable sentence. No fluff."))))
      (let ((lesson-lines (filter (fn (l) (> (str-len (str-trim l)) 10))
                                  (str-split "\n" lessons))))
        (begin
          (map (fn (l) (remember "learned" (str-trim l)))
               (take 5 lesson-lines))
          (str "Learned from " path ":\n" lessons))))))

;; Quick code health rating for a file
(define (code-health path)
  ;; Use read-file-truncated to avoid sending huge files to the LLM
  (let ((contents (read-file-truncated path 300))
        (loc (loc-count path))
        (todos (try (grep path "TODO") (catch e "")))
        (errors (try (grep path "throw new Error") (catch e ""))))
    (llm-reflect
      (str "Rate this file's health from 1-10 and explain briefly.\n\n"
           "File: " path "\n"
           "LOC: " loc "\n"
           "TODOs found: " (if (str-contains? "matches" todos) todos "none") "\n"
           "Raw Error throws: " (if (str-contains? "matches" errors) errors "none") "\n\n"
           "Content:\n" contents "\n\n"
           "Output format: SCORE: N/10 — reason"))))

;; Review a file and suggest the single highest-priority fix
(define (heal path)
  (let ((review (review-file path)))
    (let ((plan (llm-reflect
            (str "Based on this code review, produce the highest-priority fix.\n\n"
                 review "\n\n"
                 "Output EXACTLY three lines:\n"
                 "Line 1: SEARCH:<exact text to find in the file>\n"
                 "Line 2: REPLACE:<replacement text>\n"
                 "Line 3: WHY:<one sentence explaining the fix>\n\n"
                 "IMPORTANT: The SEARCH text must appear EXACTLY ONCE in the file.\n"
                 "Include enough context lines to make it unique.\n\n"
                 "If no fix needed: NO_FIX_NEEDED"))))
      (if (str-contains? "NO_FIX_NEEDED" plan)
        "No fix needed."
        (let ((lines (filter (fn (l) (not (= l ""))) (str-split "\n" plan))))
          (if (< (length lines) 3)
            (str "Heal parse failed:\n" plan)
            (let ((s-line (first lines))
                  (r-line (nth lines 1))
                  (w-line (nth lines 2)))
              (if (and (str-starts? "SEARCH:" s-line)
                       (str-starts? "REPLACE:" r-line)
                       (str-starts? "WHY:" w-line))
                (let ((search-text (str-trim (substring s-line 7 (str-len s-line))))
                      (replace-text (str-trim (substring r-line 8 (str-len r-line))))
                      (why-text (str-trim (substring w-line 4 (str-len w-line)))))
                  ;; Use safe-edit for context display and uniqueness enforcement
                  (safe-edit path search-text replace-text why-text))
                (str "Heal plan parse failed - wrong format:\n" plan)))))))))

;; Audit all strategies for weaknesses, rank by severity
;; Audit a batch of strategies in one LLM call (faster than per-strategy diagnose)
;; Usage: (self-audit) — 5 strategies; (self-audit 10) — 10; (self-audit 10 5) — skip first 5
(define (self-audit & opts)
  (let ((max-strategies (if (empty? opts) 5 (first opts)))
        (skip-count (if (< (length opts) 2) 0 (nth opts 1)))
        (all-names (strategies))
        (names (filter (fn (n)
                         (and (not (str-contains? "native" (source n)))
                              (not (str-contains? "git" n))
                              (not (= n "self-test"))
                              (not (= n "self-audit"))
                              (not (= n "agent-memory"))
                              (not (= n "strategy-history"))))
                       all-names)))
    (let ((sample (take max-strategies (drop skip-count names))))
      (if (empty? sample)
        "No strategies to audit."
        (let ((sources (map (fn (n)
                              (let ((src (source n)))
                                (str "### " n "\n"
                                     (if (> (str-len src) 600)
                                       (str (substring src 0 600) "\n... [truncated]")
                                       src))))
                            sample)))
          (llm-reflect (str "Audit these Lisp strategies for bugs.\n\n"
                            "CRITICAL: This Lisp dialect uses NEEDLE-FIRST arg order:\n"
                            "  (str-contains? needle haystack) — is needle IN haystack?\n"
                            "  (str-starts? prefix string) — does string START WITH prefix?\n"
                            "  (str-ends? suffix string) — does string END WITH suffix?\n"
                            "  (str-split separator string) — split string BY separator\n"
                            "  (str-join separator list) — join list WITH separator\n"
                            "So (str-starts? \"ERROR\" contents) is CORRECT (checks if contents starts with \"ERROR\")\n\n"
                            "Focus on REAL bugs:\n"
                            "- Unbound variables\n"
                            "- Triple-escaped newlines in str-split/str-join (wrong separator)\n"
                            "- Redundant computations\n"
                            "- Missing error handling\n\n"
                            (str-join "\n\n" sources))))))))


;; --- Git Helpers ---

;; Show git diff (optional args: "HEAD", "--staged", etc.)
(define (git-diff & opts)
  (let ((args (if (empty? opts) "" (first opts))))
    (propose-exec (str "cd /workspace/grove-cli && git diff " args)
                  "Show git diff")))

;; Show recent git history (default: 10 commits)
(define (git-log & opts)
  (let ((n (if (empty? opts) 10 (first opts))))
    (propose-exec (str "cd /workspace/grove-cli && git log --oneline -"
                       (number->string n))
                  "Show recent git history")))

;; Stage all changes and commit with message
(define (git-commit message)
  (let ((escaped (reduce (fn (acc ch) (if (= ch "'") (str acc "'\"'\"'") (str acc ch)))
                         "" (str-split "" message))))
    (propose-exec (str "cd /workspace/grove-cli && git add -A && git commit -m '"
                       escaped "'")
                  (str "Commit: " message))))

;; Blame a file (optional: "start,end" line range)
(define (git-blame path & opts)
  (let ((args (if (empty? opts) "" (str " -L " (first opts)))))
    (propose-exec (str "cd /workspace/grove-cli && git blame" args " " path)
                  (str "Blame: " path))))

;; --- File Utilities ---

;; Read file, truncating middle if over max-lines (keeps head + tail context)
(define (read-file-truncated path max-lines)
  (let ((contents (read-file path)))
    (if (str-starts? "ERROR" contents) contents
      (let ((lines (str-split "\n" contents)))
        (if (> (length lines) max-lines)
          (let ((head-count (max 50 (- max-lines 20))))
            (str-join "\n"
              (append (take head-count lines)
                      (list (str "\n... [truncated "
                                 (- (length lines) max-lines)
                                 " lines] ...\n"))
                      (take 20 (drop (- (length lines) 20) lines)))))
          contents)))))

;; --- Testing ---

;; Conditional test helper macro
(defmacro (test-when test body)
  `(if ~test ~body nil))

;; Assert equality, return pass/fail string
(define (assert-eq name expected actual)
  (if (= expected actual)
    (str "  ✓ " name)
    (str "  ✗ " name " — expected " (print expected) " got " (print actual))))

;; Run a list of test thunks, report results
(define (run-tests & tests)
  (let ((results (map (fn (t) (try (t) (catch e (str "  ✗ CRASH: " e)))) tests))
        (passed (length (filter (fn (r) (str-starts? "  ✓" r)) results)))
        (total (length results)))
    (str "=== Tests: " (number->string passed) "/" (number->string total) " passed ===\
"
         (str-join "\
" results))))

;; Self-test — regression suite (cleans up test probes after memory test)
;; Self-test — full regression suite (50 tests)
(define (self-test)
  (let ((result (run-tests
    (fn () (assert-eq "arithmetic" 6 (+ 1 2 3)))
    (fn () (assert-eq "strings" "a-b" (str-join "-" (list "a" "b"))))
    (fn () (assert-eq "lists" (list 2 4) (map (fn (x) (* x 2)) (list 1 2))))
    (fn () (assert-eq "filter" (list 2) (filter (fn (x) (> x 1)) (list 1 2))))
    (fn () (assert-eq "reduce" 6 (reduce + 0 (list 1 2 3))))
    (fn () (assert-eq "& variadics" (list 2 3) ((fn (a & r) r) 1 2 3)))
    (fn () (assert-eq "try/catch" "caught" (try (car nil) (catch e "caught"))))
    (fn () (assert-eq "pipeline" 7 (pipeline 3 (fn (x) (* x 2)) (fn (x) (+ x 1)))))
    (fn () (assert-eq "json" "{\"x\":1}" (sexp->json (list (list :x 1)))))
    (fn () (assert-eq "eval" 5 (eval (list '+ 2 3))))
    (fn () (assert-eq "tool-bridge" #t (str-contains? "grove" (read-file "package.json"))))
    (fn () (assert-eq "grep" #t (str-contains? "matches" (grep "package.json" "name"))))
    (fn () (assert-eq "loc-count" #t (str-contains? "non-blank" (loc-count "package.json"))))
    (fn () (assert-eq "head" #t (str-contains? "name" (head "package.json" 2))))
    (fn () (assert-eq "inspect" #t (list? (inspect "safe-call"))))
    (fn () (assert-eq "strategies" #t (> (length (strategies)) 50)))
    (fn () (assert-eq "tail" #t (str-contains? "}" (tail "package.json" 2))))
    (fn () (let ((result (mem "test" "self-test-probe" '("testing"))))
              (assert-eq "mem-create" #t (str-contains? "self-test-probe" result))))
    (fn () (assert-eq "mem-search" #t (not (empty? (mem-search "self-test-probe")))))
    (fn () (assert-eq "mem-by-tag" #t (not (empty? (mem-by-tag "testing")))))
    (fn () (assert-eq "source" #t (str-contains? "define" (source "safe-call"))))
    (fn () (assert-eq "diagnose-exists" #t (list? (inspect "diagnose"))))
    (fn () (assert-eq "audit-exists" #t (list? (inspect "audit-module"))))
    (fn () (assert-eq "every?" #t (every? (fn (x) (> x 0)) (list 1 2 3))))
    (fn () (assert-eq "some?" #t (some? (fn (x) (> x 2)) (list 1 2 3))))
    (fn () (assert-eq "take" (list 1 2) (take 2 (list 1 2 3 4))))
    (fn () (assert-eq "drop" (list 3 4) (drop 2 (list 1 2 3 4))))
    (fn () (assert-eq "zip" (list (list 1 "a") (list 2 "b")) (zip (list 1 2) (list "a" "b"))))
    (fn () (assert-eq "flat-map" (list 1 10 2 20) (flat-map (fn (x) (list x (* x 10))) (list 1 2))))
    (fn () (assert-eq "partial" 8 ((partial + 5) 3)))
    (fn () (assert-eq "compose" 7 ((compose (fn (x) (+ x 1)) (fn (x) (* x 2))) 3)))
    (fn () (assert-eq "empty?" #t (and (empty? (list)) (not (empty? (list 1))))))
    (fn () (assert-eq "when-true" 42 (when #t 42)))
    (fn () (assert-eq "when-false" nil (when #f 42)))
    (fn () (assert-eq "unless" 42 (unless #f 42)))
    (fn () (assert-eq "threading" 7 (-> 3 (* 2) (+ 1))))
    ;; List accessor tests
    (fn () (assert-eq "second" 2 (second (list 1 2 3))))
    (fn () (assert-eq "third" 3 (third (list 1 2 3))))
    (fn () (assert-eq "last" 3 (last (list 1 2 3))))
    (fn () (assert-eq "last-empty" nil (last (list))))
    ;; Boolean tests
    (fn () (assert-eq "not-falsy" #t (not #f)))
    (fn () (assert-eq "not-truthy" #f (not #t)))
    ;; Extended functional utility tests
    (fn () (assert-eq "find-first" 3 (find-first (fn (x) (> x 2)) (list 1 2 3 4))))
    (fn () (assert-eq "take-while" (list 1 2) (take-while (fn (x) (< x 3)) (list 1 2 3 4))))
    (fn () (assert-eq "drop-while" (list 3 4) (drop-while (fn (x) (< x 3)) (list 1 2 3 4))))
    (fn () (assert-eq "count-matches" 3 (count-matches "l" "hello world")))
    ;; String operation tests (arg order: str-replace s target replacement; str-index-of substr s)
    (fn () (assert-eq "str-replace" "hi there" (str-replace "hi world" "world" "there")))
    (fn () (assert-eq "str-index-of" 4 (str-index-of "o" "hello world")))
    ;; Collection utility tests
    (fn () (assert-eq "group-by" 2 (length (group-by (fn (x) (mod x 2)) (list 1 2 3 4)))))
    (fn () (assert-eq "distinct" (list 1 2 3) (distinct (list 1 2 1 3 2))))
    ;; Control flow tests
    (fn () (assert-eq "retry" "ok" (retry 3 (fn () "ok"))))
    (fn () (assert-eq "first-success" 42 (first-success (fn () (error "x")) (fn () 42)))))))
    ;; Clean up test probes from the memory store
    (mem-delete-cat! "test")
    result))
