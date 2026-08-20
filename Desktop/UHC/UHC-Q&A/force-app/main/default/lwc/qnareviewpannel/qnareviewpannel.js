import { LightningElement, api, wire } from 'lwc';
import { loadScript, loadStyle } from 'lightning/platformResourceLoader';
import getReviewData from '@salesforce/apex/QnaReviewController.getReviewData';
import getRepositoryFilterOptions from '@salesforce/apex/QnaReviewController.getRepositoryFilterOptions';
import getAnswersForQuestion from '@salesforce/apex/QnaAnswerSearchController.getAnswersForQuestion';
import getAnswersForAllQuestions from '@salesforce/apex/QnaAnswerSearchController.getAnswersForAllQuestions';
import rerunSearch from '@salesforce/apex/QnaAnswerSearchController.rerunSearch';
import searchWithFilters from '@salesforce/apex/QnaAnswerSearchController.searchWithFilters';
import saveAnswer from '@salesforce/apex/QnaReviewController.saveAnswer';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import applyStrategy from '@salesforce/apex/QnaAIActionsController.applyStrategy';
import assessStrategyApplicability from '@salesforce/apex/QnaAIActionsController.assessStrategyApplicability';
import editWithAI from '@salesforce/apex/QnaAIActionsController.editWithAI';
import styleAnswer from '@salesforce/apex/QnaAIActionsController.styleAnswer';
import DiffLib from '@salesforce/resourceUrl/DiffLib';
import QnaModalStyles from '@salesforce/resourceUrl/QnaModalStyles';
import markActionApplied from '@salesforce/apex/QnaAIActionsController.markActionApplied';
import unmarkActionApplied from '@salesforce/apex/QnaAIActionsController.unmarkActionApplied';
import markSelectedAnswer from '@salesforce/apex/QnaReviewController.markSelectedAnswer';
import checkAndLockQuestion from '@salesforce/apex/QnaQuestionLockService.checkAndLockQuestion';
import refreshQuestionLock from '@salesforce/apex/QnaQuestionLockService.refreshQuestionLock';
import unlockQuestion from '@salesforce/apex/QnaQuestionLockService.unlockQuestion';
import toggleStar from '@salesforce/apex/QnaReviewController.toggleStar';
import saveFeedback from '@salesforce/apex/QnaFeedbackController.saveFeedback';

export default class QaReviewWorkspace extends LightningElement {
    @api recordId;
    @api strategyMode = false;

    documentName = '';
    membershipActivityName = '';
    allQuestions = [];
    currentIndex = 0;
    matchIndex = 0;
    isLoading = true;
    isLoadingMatches = false;
    error;
    isCompleted = false;

    // Header filters
    statusFilter = 'All';
    sectionFilter = 'All';

    // Footer question search
    questionSearchTerm = '';
    numberNotFound = false;

    // Progress summary modal
    showProgressSummary = false;
    summaryFilter = 'All';   // 'All' | 'Finalised' | 'Not Finalised'

    // Search panel state
    showSearchPanel = false;

    // Match-details collapse state
    matchDetailsOpen = false;

    // Answer show more / less
    answerExpanded = false;
    showAnswerToggle = false;
    _measureAnswer = true;   // triggers an overflow measurement on next render

    // Edit mode state
    isEditing = false;
    selectedMatch = null;
    editAnswer = '';
    rteReadOnly = true;   // pencil enables editing; close-edit locks it again
    isSaving = false;     // guards against double-submit while a save is in flight
    showCompleteConfirm = false;  // mark-as-complete confirmation dialog

    // Tracks where the current working answer came from, so Match_Used__c is set
    // correctly at finalise. true = Select & Edit (a repository match), false =
    // Draft New. On reopen it's seeded from the stored value so a re-finalise
    // doesn't wrongly flip a previously-selected answer to false.
    _matchUsed = false;

    // Unsaved-changes guard
    showUnsavedConfirm = false;   // "discard unsaved changes?" dialog
    _editBaseline = '';           // editAnswer value at the moment editing started

    // Progress baseline — captured when the editor opens so a discard can
    // roll back styled / strategy progress made during this edit session.
    _baselineStyled = false;
    _baselineStrategy = false;

    // Tracks which AI actions (style / strategy) were applied during the current
    // edit session, so a discard undoes exactly what this session did — regardless
    // of any stale flags already on the record.
    _sessionAppliedActions = new Set();

    // Style flow state
    isStyleLoading = false;
    showStyleConfirm = false;     // "about to style" confirmation
    showStyleDiff = false;        // styled-answer modal
    showStyleDiffView = false;    // eye toggle: false = plain styled text (default), true = red/green diff
    styledAnswerResult = '';      // raw styled text returned from Apex
    diffedFinalAnswer = '';       // left panel: removals struck in red
    diffedStyled = '';            // right panel: additions in green
    _diffLibLoaded = false;

    // Repository filter options (loaded once from Q_A_Document_Repository__c)
    repositoryOptions = {};

    // Lookup search state
    openDropdown = null;
    dropdownSearch = '';

    // Strategy comparison modal state
    showStrategyCompare = false;
    isStrategyLoading = false;
    strategyAnswer = '';
    strategyReasoning = [];    // [{strategy_point_id, strategy_point, change_made}]
    strategyReasoningOpen = false;
    originalAnswerSnapshot = '';
    showStrategyDiffView = false;  // eye toggle: false = plain text (default), true = red/green diff
    diffedStrategyOriginal = '';   // left panel: removals struck in red
    diffedStrategy = '';           // right panel: additions in green

    // Strategy applicability check modal state
    showStrategySkipConfirm = false;
    strategySkipReason = '';

    // Style overwrite warning modal state
    showStyleOverwriteWarning = false;

    // Edit-with-AI modal state
    showEditAIInstructions = false;   // Instructions modal
    showEditAIResult = false;         // AI Revised Answer modal
    editInstructions = '';
    aiRevisedAnswer = '';
    isEditAILoading = false;
    _styleApplied = false;

    // ── AI feedback (thumbs) — one row per modal session, per source ──────────
    styleFeedbackRating;
    strategyFeedbackRating;
    editaiFeedbackRating;
    _styleFeedbackId = null;
    _strategyFeedbackId = null;
    _editaiFeedbackId = null;

    // Re-run state
    isRerunning = false;
    showRerunCompleteWarning = false;


    // Concurrent-edit lock state (per question) + heartbeat
    isLockedByOther = false;
    lockOwnerName = '';
    _lockedQuestionId = null;      // the question this session currently owns the lock on
    _heartbeatId = null;           // setInterval id keeping the lock fresh
    _beforeUnloadHandler = null;   // window listener -> best-effort release on tab close

    // Live matches — loaded from Q_A_Answer__c per question
    currentMatches = [];
    matchesCache = {};   // { questionId: mappedArray } — not reactive, used for client-side caching

    // Match dimension filters
    filterCompany = '';
    filterConsultingFirm = '';
    filterIndustry = '';
    filterFileName = '';
    filterRfpName = '';
    filterSvpName = '';
    filterTopicArea = '';

    _wasOverAnswerLimit = false;

    statusOptions = [
        { label: 'All Questions', value: 'All' },
        { label: 'Not Finalised', value: 'Not Finalised' },
        { label: 'Finalised', value: 'Finalised' },
        { label: 'Starred', value: 'Starred' }
    ];

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    connectedCallback() {
        loadStyle(this, QnaModalStyles).catch(() => {});
        loadScript(this, DiffLib)
            .then(() => { this._diffLibLoaded = true; })
            .catch(err => console.error('Failed to load DiffLib', err));

        // Best-effort release when the tab/browser closes (2-min TTL is the fallback)
        this._beforeUnloadHandler = () => this._releaseLock();
        window.addEventListener('beforeunload', this._beforeUnloadHandler);
    }

    disconnectedCallback() {
        this._stopHeartbeat();
        if (this._beforeUnloadHandler) {
            window.removeEventListener('beforeunload', this._beforeUnloadHandler);
            this._beforeUnloadHandler = null;
        }
        this._releaseLock();
    }

    // ── Wire ────────────────────────────────────────────────────────────────

    @wire(getRepositoryFilterOptions)
    wiredFilterOptions({ data }) {
        if (data) this.repositoryOptions = data;
    }

    @wire(getReviewData, { documentId: '$recordId' })
    wiredData({ data, error }) {
        if (data) {
            this.documentName = data.documentName;
            this.membershipActivityName = data.membershipActivityName;
            this.allQuestions = data.questions || [];
            this.isLoading = false;
            this.error = undefined;

            // Bulk-prefetch all questions' stored answers in one Apex call so that
            // navigating between questions is instant (served from matchesCache).
            const questionIds = this.allQuestions.map(q => q.id).filter(Boolean);
            if (questionIds.length > 0) {
                getAnswersForAllQuestions({ questionIds })
                    .then(answersMap => {
                        this.allQuestions.forEach(q => {
                            if (!Object.prototype.hasOwnProperty.call(this.matchesCache, q.id)) {
                                this.matchesCache[q.id] = this._sortMatches(
                                    (answersMap[q.id] || []).map(r => this._mapRecord(r))
                                );
                            }
                        });
                        this.loadMatchesForQuestion();
                    })
                    .catch(() => {
                        // Prefetch failed — fall back to on-demand loading per question
                        this.loadMatchesForQuestion();
                    });
            } else {
                this.loadMatchesForQuestion();
            }
        } else if (error) {
            this.error = this._extractError(error);
            this.isLoading = false;
        }
    }

    get showEditButton() {
        return this.strategyMode && !this.isEditing && !this.isLockedByOther;
    }
    get showAnswerCount() {
    return this.answerWordLimit != null;
}

    // Measure whether the answer overflows its clipped height, and show the
    // Show more / Show less toggle only when it does. Also injects rich-text
    // answers (editor read-only + review finalised) since innerHTML can't bind.
    renderedCallback() {
        // Style diff modal — inject diff HTML or plain styled text based on the eye toggle
        if (this.showStyleDiff) {
            const finalBox = this.template.querySelector('[data-diff="final"]');
            const finalHtml = this.showStyleDiffView ? this.diffedFinalAnswer : this.editAnswer;
            if (finalBox && finalBox.dataset.rendered !== finalHtml) {
                finalBox.innerHTML = finalHtml || '<em>No answer.</em>';
                finalBox.dataset.rendered = finalHtml;
            }
            const styledBox = this.template.querySelector('[data-diff="styled"]');
            const styledHtml = this.showStyleDiffView ? this.diffedStyled : this.styledAnswerResult;
            if (styledBox && styledBox.dataset.rendered !== styledHtml) {
                styledBox.innerHTML = styledHtml || '<em>No answer.</em>';
                styledBox.dataset.rendered = styledHtml;
            }
            return;
        }

        // Strategy comparison modal — inject diff HTML or plain text based on the eye toggle
        if (this.showStrategyCompare) {
            const origBox = this.template.querySelector('[data-side="original"]');
            const origHtml = this.showStrategyDiffView ? this.diffedStrategyOriginal : this.originalAnswerSnapshot;
            if (origBox && origBox.dataset.rendered !== origHtml) {
                origBox.innerHTML = origHtml || '<em>No answer.</em>';
                origBox.dataset.rendered = origHtml;
            }
            const aiBox = this.template.querySelector('[data-side="strategy"]');
            const aiHtml = this.showStrategyDiffView ? this.diffedStrategy : this.strategyAnswer;
            if (aiBox && aiBox.dataset.rendered !== aiHtml) {
                aiBox.innerHTML = aiHtml || '<em>No answer.</em>';
                aiBox.dataset.rendered = aiHtml;
            }
            return;
        }

        // Edit mode, completed → read-only answer HTML
        if (this.isEditing && this.isCompleted) {
            const box = this.template.querySelector('.answer-readonly');
            if (box && box.dataset.rendered !== this.editAnswer) {
                box.innerHTML = this.editAnswer || '<em>No answer.</em>';
                box.dataset.rendered = this.editAnswer;
            }
            return;
        }

        // Review mode, question has a finalised answer → render it as HTML
        if (!this.isEditing && this.hasFinalAnswer) {
            const box = this.template.querySelector('.answer-final');
            if (box && box.dataset.rendered !== this.finalAnswer) {
                box.innerHTML = this.finalAnswer;
                box.dataset.rendered = this.finalAnswer;
            }
            return;
        }

        if (!this._measureAnswer || this.isEditing || this.answerExpanded) return;
        const el = this.template.querySelector('.match-a');
        if (el) {
            this.showAnswerToggle = el.scrollHeight > el.clientHeight + 2;
            this._measureAnswer = false;
        }
    }

    // ── Match loading ────────────────────────────────────────────────────────

    loadMatchesForQuestion() {
        const question = this.filteredQuestions[this.currentIndex];
        if (!question || !question.id) return;

        const qId = question.id;

        // Acquire lock for this question; releases lock on the previous one
        this._acquireQuestionLock(qId);

        // If any filter is active, run a fresh filtered search against Data Cloud
        if (this._hasActiveMatchFilters()) {
            this._runFilteredSearch();
            return;
        }

        // Serve from client cache if already fetched
        if (Object.prototype.hasOwnProperty.call(this.matchesCache, qId)) {
            this.currentMatches = this.matchesCache[qId];
            this.matchIndex = 0;
            this._resetAnswerView();
            return;
        }

        this.isLoadingMatches = true;
        this.currentMatches = [];

        getAnswersForQuestion({ questionId: qId, questionText: question.questionText })
            .then(records => {
                const sorted = this._sortMatches((records || []).map(r => this._mapRecord(r)));
                this.matchesCache[qId] = sorted;
                this.currentMatches = sorted;
                this.matchIndex = 0;
                this.isLoadingMatches = false;
                this._resetAnswerView();
            })
            .catch(() => {
                this.matchesCache[qId] = [];
                this.currentMatches = [];
                this.isLoadingMatches = false;
            });
    }

    _mapRecord(r) {
        return {
            id: r.Id,
            score: r.Match_Score__c != null ? r.Match_Score__c : '—',
            matchQuality: r.Match_Quality__c || '',
            rfp: r.RFP_Name__c || '',
            effectivePeriod: r.Effective_Period__c || '',
            company: r.Company__c || '',
            consultingFirm: r.Consulting_Firm__c || '',
            industry: r.Industry__c || '',
            fileName: r.File_Name__c || '',
            svpName: r.SVP_Name__c || '',
            topicArea: r.Topic_Area__c || '',
            question: r.D360_Data_Source_ID__c || '',
            answer: r.Answer__c || '',
            isSelected: r.Is_Selected_Answer__c || false
        };
    }

    _sortMatches(matches) {
        return [...matches].sort((a, b) => {
            // 1. Highest score first ('—' treated as 0)
            const sa = typeof a.score === 'number' ? a.score : 0;
            const sb = typeof b.score === 'number' ? b.score : 0;
            if (sb !== sa) return sb - sa;
            // 2. Has consulting firm beats no consulting firm
            const ca = a.consultingFirm ? 1 : 0;
            const cb = b.consultingFirm ? 1 : 0;
            if (cb !== ca) return cb - ca;
            // 3. Most recent effectivePeriod first (lexicographic desc works for year strings)
            if (a.effectivePeriod && b.effectivePeriod) return b.effectivePeriod.localeCompare(a.effectivePeriod);
            if (b.effectivePeriod) return 1;
            if (a.effectivePeriod) return -1;
            return 0;
        });
    }

    _hasActiveMatchFilters() {
        return !!(this.filterCompany || this.filterConsultingFirm ||
            this.filterIndustry || this.filterFileName ||
            this.filterRfpName || this.filterSvpName || this.filterTopicArea);
    }

    _runFilteredSearch() {
        const question = this.filteredQuestions[this.currentIndex];
        if (!question || !question.id) return;

        this.isLoadingMatches = true;
        this.currentMatches = [];
        this.matchIndex = 0;

        searchWithFilters({
            questionId: question.id,
            questionText: question.questionText,
            filterCompany: this.filterCompany || null,
            filterConsultingFirm: this.filterConsultingFirm || null,
            filterIndustry: this.filterIndustry || null,
            filterRfpName: this.filterRfpName || null,
            filterSvpName: this.filterSvpName || null,
            filterTopicArea: this.filterTopicArea || null,
            filterFileName: this.filterFileName || null
        })
            .then(records => {
                this.currentMatches = this._sortMatches((records || []).map(r => this._mapRecord(r)));
                this.isLoadingMatches = false;
                this._resetAnswerView();
            })
            .catch(() => {
                this.currentMatches = [];
                this.isLoadingMatches = false;
            });
    }

    // ── Question lock (concurrent-edit guard) + heartbeat ────────────────────

    _acquireQuestionLock(questionId) {
        // Stop the heartbeat and release the previously-locked question
        this._stopHeartbeat();
        if (this._lockedQuestionId && this._lockedQuestionId !== questionId) {
            unlockQuestion({ questionId: this._lockedQuestionId }).catch(() => { });
            this._lockedQuestionId = null;
        }
        // Reset lock UI for the incoming question
        this.isLockedByOther = false;
        this.lockOwnerName = '';

        checkAndLockQuestion({ questionId })
            .then(result => {
                if (result.isLockedByOther) {
                    this.isLockedByOther = true;
                    this.lockOwnerName = result.lockedByName;
                    // Not ours — no heartbeat
                } else {
                    this._lockedQuestionId = questionId;
                    this._startHeartbeat();   // ours -> keep it fresh past the 2-min TTL
                }
            })
            .catch(() => { }); // lock is best-effort; silent failure keeps UX unblocked
    }

    // Refresh every 60s so an active editor keeps the lock past the 2-min TTL
    _startHeartbeat() {
        this._stopHeartbeat();
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        this._heartbeatId = window.setInterval(() => {
            if (!this._lockedQuestionId) { this._stopHeartbeat(); return; }
            refreshQuestionLock({ questionId: this._lockedQuestionId })
                .then(ok => {
                    if (!ok) {
                        // Lock is no longer ours (e.g. TTL lapsed while backgrounded)
                        this._stopHeartbeat();
                        this._lockedQuestionId = null;
                        this.isLockedByOther = true;
                        if (!this.lockOwnerName) this.lockOwnerName = 'another user';
                        this._showToast('View only', 'This question is now being edited by someone else.', 'warning');
                    }
                })
                .catch(() => {
                    // Stop retrying every second; the 2-min TTL is the safety net
                    this._stopHeartbeat();
                });
        }, 60000);
    }

    _stopHeartbeat() {
        if (this._heartbeatId) {
            window.clearInterval(this._heartbeatId);
            this._heartbeatId = null;
        }
    }

    _releaseLock() {
        this._stopHeartbeat();
        if (this._lockedQuestionId) {
            unlockQuestion({ questionId: this._lockedQuestionId }).catch(() => { });
            this._lockedQuestionId = null;
        }
    }

    // ── Re-run search ────────────────────────────────────────────────────────

    get isRerunDisabled() {
        return this.isRerunning || this.isLockedByOther;
    }

    handleRerun() {
        const question = this.currentQuestion;
        if (!question || !question.id || this.isRerunDisabled) return;
        this.showRerunCompleteWarning = true;
    }

    handleRerunCompleteConfirm() {
        this.showRerunCompleteWarning = false;
        this._executeRerun();
    }

    handleRerunCompleteCancel() {
        this.showRerunCompleteWarning = false;
    }

    _executeRerun() {
        const question = this.currentQuestion;
        if (!question || !question.id) return;

        this.isRerunning = true;
        const qId = question.id;

        rerunSearch({ questionId: qId })
            .then(updatedQ => {
                // Clear client cache so fresh answers are loaded from the server
                delete this.matchesCache[qId];
                this.currentMatches = [];
                this.matchIndex = 0;

                // Always reset all progress flags — a rerun discards the old answer
                // and fetches fresh matches, so draft/styled/strategy state no longer applies.
                const newStatus = updatedQ?.Status__c || 'New';
                this.allQuestions = this.allQuestions.map(q =>
                    q.id === qId
                        ? { ...q, status: newStatus, finalAnswer: null, strategyApplied: false, isStyled: false }
                        : q
                );
                this.isCompleted = false;
                this.isEditing = false;
                this._styleApplied = false;
                this._sessionAppliedActions = new Set();

                this.isRerunning = false;
                this.loadMatchesForQuestion();
                this._showToast('Success', 'Search re-run complete. Fresh matches loaded.', 'success');
            })
            .catch(error => {
                this.isRerunning = false;
                this._showToast('Error', this._extractError(error), 'error');
            });
    }

    // ── Header ──────────────────────────────────────────────────────────────

    get headerName() {
        return this.membershipActivityName || this.documentName;
    }

    get filterToggleLabel() {
        return this.showSearchPanel ? 'Close Search' : 'Search';
    }

    // ── Footer question search ────────────────────────────────────────────────

    get searchPlaceholder() {
        return 'Search a Question (by Question Number or Keywords).';
    }
    get isCurrentQuestionComplete() {
        return this.currentQuestion?.status === 'Completed';
    }
    get rerunStatusIsDraft() {
        return this.currentQuestion?.status === 'Draft';
    }
  get rerunStatusIsStyled() {
    return this.currentQuestion?.isStyled === true;
}
    get rerunStatusStrategyApplied() {
        return this.currentQuestion?.strategyApplied === true;
    }
    get rerunHasProgress() {
        return this.rerunStatusIsDraft || this.isCurrentQuestionComplete || this.rerunStatusIsStyled || this.rerunStatusStrategyApplied;
    }
    get questionHasTable() {
        const text = this.currentQuestion?.questionText || '';
        return text.includes('|');
    }
    get questionParts() {
        const text = this.currentQuestion?.questionText || '';
        if (!text.includes('|')) return [];
        const lines = text.split('\n');
        const parts = [];
        let textLines = [];
        let i = 0;
        while (i < lines.length) {
            const trimmed = lines[i].trim();
            if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
                if (textLines.length > 0) {
                    parts.push({ key: 'txt' + i, isText: true, isTable: false, content: textLines.join('\n') });
                    textLines = [];
                }
                const tableLines = [];
                while (i < lines.length) {
                    const t = lines[i].trim();
                    if (t.startsWith('|') && t.endsWith('|')) { tableLines.push(t); i++; }
                    else break;
                }
                const allRows = tableLines.map((l, ri) => {
                    const cells = l.slice(1, -1).split('|').map((c, ci) => ({ key: 'c' + ri + '_' + ci, label: c.trim() }));
                    return { key: 'tr' + ri, cells };
                });
                const headers = allRows[0] ? allRows[0].cells : [];
                const rows = allRows.slice(1);
                parts.push({ key: 'tbl' + i, isText: false, isTable: true, headers, rows });
            } else {
                if (trimmed) textLines.push(trimmed);
                i++;
            }
        }
        if (textLines.length > 0) {
            parts.push({ key: 'txt-end', isText: true, isTable: false, content: textLines.join('\n') });
        }
        return parts;
    }

    // ── Progress pipeline ─────────────────────────────────────────────────────
    // A step is "done" when its underlying flag is set. Draft is considered done
    // when a draft has been saved OR the question is complete. Segments fill to
    // reflect forward progress along the pipeline.
    get isDraftDone() { return this.rerunStatusIsDraft || this.isCurrentQuestionComplete; }
    get isStyledDone() { return this.rerunStatusIsStyled; }
    get isStrategyDone() { return this.rerunStatusStrategyApplied; }
    get isFinalizedDone() { return this.isCurrentQuestionComplete; }

    get pipelineDraftClass() { return 'pipeline-step' + (this.isDraftDone ? ' pipeline-step--done pipeline-step--draft' : ''); }
    get pipelineStyledClass() { return 'pipeline-step' + (this.isStyledDone ? ' pipeline-step--done pipeline-step--styled' : ''); }
    get pipelineStrategyClass() { return 'pipeline-step' + (this.isStrategyDone ? ' pipeline-step--done pipeline-step--strategy' : ''); }
    get pipelineFinalizedClass() { return 'pipeline-step' + (this.isFinalizedDone ? ' pipeline-step--done pipeline-step--finalized' : ''); }
    get pipelineSeg1Class() { return 'pipeline-seg' + (this.isStyledDone ? ' pipeline-seg--fill' : ''); }
    get pipelineSeg2Class() { return 'pipeline-seg' + (this.isStrategyDone ? ' pipeline-seg--fill' : ''); }
    get pipelineSeg3Class() { return 'pipeline-seg' + (this.isFinalizedDone ? ' pipeline-seg--fill' : ''); }

    // Legacy checklist getters — kept for backward compatibility if referenced
    get checkDraftClass() { return 'check-item' + (this.rerunStatusIsDraft ? ' check-item--on check-item--draft' : ' check-item--off'); }
    get checkStyledClass() { return 'check-item' + (this.rerunStatusIsStyled ? ' check-item--on check-item--styled' : ' check-item--off'); }
    get checkStrategyClass() { return 'check-item' + (this.rerunStatusStrategyApplied ? ' check-item--on check-item--strategy' : ' check-item--off'); }

    get pillDraftClass() { return 'rerun-pill ' + (this.rerunStatusIsDraft ? 'rerun-pill--draft' : 'rerun-pill--inactive'); }
    get pillFinalizedClass() { return 'rerun-pill ' + (this.isCurrentQuestionComplete ? 'rerun-pill--complete' : 'rerun-pill--inactive'); }
    get pillStyledClass() { return 'rerun-pill ' + (this.rerunStatusIsStyled ? 'rerun-pill--styled' : 'rerun-pill--inactive'); }
    get pillStrategyClass() { return 'rerun-pill ' + (this.rerunStatusStrategyApplied ? 'rerun-pill--strategy' : 'rerun-pill--inactive'); }
    get checkDraftIcon() { return this.rerunStatusIsDraft ? '☑' : '☐'; }
    get checkStyledIcon() { return this.rerunStatusIsStyled ? '☑' : '☐'; }
    get checkStrategyIcon() { return this.rerunStatusStrategyApplied ? '☑' : '☐'; }
    get finalAnswer() {
        return this.currentQuestion?.finalAnswer || '';
    }
    get hasFinalAnswer() {
        return !!(this.currentQuestion && this.currentQuestion.finalAnswer);
    }

    handleQuestionSearch(event) {
        const term = event.target.value;
        this.questionSearchTerm = term;

        const trimmed = term.trim();

        // Number or hierarchical number entered (e.g. "5" or "2.1.3") -> jump to that question.
        if (/^\d+(\.\d+)*$/.test(trimmed)) {
            const list = this.filteredQuestions;
            const idx = list.findIndex((q, i) => {
                const displayNum = q.questionNumber != null ? String(q.questionNumber) : String(i + 1);
                return displayNum === trimmed;
            });
            if (idx !== -1) {
                this.numberNotFound = false;
                this.currentIndex = idx;
                this.matchIndex = 0;
                this._resetAnswerView();
                this.loadMatchesForQuestion();
                return;
            }
            // Number typed but no matching question -> show the empty state,
            // same as a keyword search with no results.
            this.numberNotFound = true;
            return;
        }

        this.numberNotFound = false;
        this.currentIndex = 0;
        this.matchIndex = 0;
        this._resetAnswerView();
        this.loadMatchesForQuestion();
    }

    // ── Progress summary ──────────────────────────────────────────────────────

    // Counts across ALL questions (not affected by the summary filter itself)
    get summaryCounts() {
        const total = this.allQuestions.length;
        const finalised = this.allQuestions.filter(q => q.status === 'Completed').length;
        return { total, finalised, notFinalised: total - finalised };
    }

    get summaryOptions() {
        const c = this.summaryCounts;
        return [
            { label: 'All', value: 'All', disabled: c.total === 0 },
            { label: 'Finalised', value: 'Finalised', disabled: c.finalised === 0 },
            { label: 'Not Finalised', value: 'Not Finalised', disabled: c.notFinalised === 0 }
        ];
    }

    get summaryRows() {
        return this.allQuestions
            .filter(q => {
                if (this.summaryFilter === 'Finalised') return q.status === 'Completed';
                if (this.summaryFilter === 'Not Finalised') return q.status !== 'Completed';
                return true;
            })
            .map(q => {
                const isFinal = q.status === 'Completed';
                return {
                    id: q.id,
                    number: q.questionNumber != null
                        ? q.questionNumber
                        : this.allQuestions.indexOf(q) + 1,
                    text: q.questionText,
                    finalisedLabel: isFinal ? 'Finalised' : 'Not Finalised',
                    finalisedClass: isFinal ? 'ps-badge ps-badge--finalised' : 'ps-badge ps-badge--not-finalised',
                    finalisedBy: isFinal ? (q.finalisedBy || '—') : ''
                };
            });
    }

    get hasSummaryRows() {
        return this.summaryRows.length > 0;
    }

    get summaryLine() {
        const c = this.summaryCounts;
        return `${c.finalised} have been finalised, Out of ${c.total} questions and ${c.notFinalised} are work in progress.`;
    }

    handleShowProgressSummary() {
        // Default to a filter that actually has questions; fall back to All.
        const c = this.summaryCounts;
        if (this.summaryFilter === 'Finalised' && c.finalised === 0) this.summaryFilter = 'All';
        else if (this.summaryFilter === 'Not Finalised' && c.notFinalised === 0) this.summaryFilter = 'All';
        if (!this.summaryFilter) this.summaryFilter = 'All';
        this.showProgressSummary = true;
    }

    closeProgressSummary() {
        this.showProgressSummary = false;
    }

    handleSummaryFilterSelect(event) {
        this.summaryFilter = event.detail.value;
    }

    // Click a question number → jump to that question and open it
    handleSummaryQuestionClick(event) {
        const qid = event.currentTarget.dataset.qid;
        if (!qid) return;

        // Make sure the target is visible under the current header filters;
        // if it's filtered out, reset filters so we can navigate to it.
        let idx = this.filteredQuestions.findIndex(q => q.id === qid);
        if (idx === -1) {
            this.statusFilter = 'All';
            this.sectionFilter = 'All';
            this.questionSearchTerm = '';
            this.numberNotFound = false;
            idx = this.filteredQuestions.findIndex(q => q.id === qid);
        }
        if (idx !== -1) {
            this.currentIndex = idx;
            this.matchIndex = 0;
            this.isEditing = false;
            this._resetAnswerView();
            this.showProgressSummary = false;
            this.loadMatchesForQuestion();
        }
    }

    // ── Answer show more / less ───────────────────────────────────────────────

    get answerClass() {
        if (this.answerExpanded) return 'match-a';
        return this.showAnswerToggle ? 'match-a clip clip-fade' : 'match-a clip';
    }

    get answerToggleLabel() {
        return this.answerExpanded ? 'Show less' : 'Show more';
    }

    toggleAnswer() {
        this.answerExpanded = !this.answerExpanded;
    }

    _resetAnswerView() {
        this.answerExpanded = false;
        this.showAnswerToggle = false;
        this._measureAnswer = true;
    }


    get _plainAnswerText() {
    const html = this.editAnswer || '';
    return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').trim();
}

get answerWordCount() {
    const text = this._plainAnswerText;
    return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

get answerWordLimit() {
    const limit = this.currentQuestion?.answerSizeLimit;
    return (limit != null && limit > 0) ? limit : null;
}

get isAnswerOverLimit() {
    const limit = this.answerWordLimit;
    return limit != null && this.answerWordCount > limit;
}

get answerCountLabel() {
    const limit = this.answerWordLimit;
    return limit != null
        ? `Word Counts: ${this.answerWordCount} / ${limit} words`
        : `Word Count: ${this.answerWordCount}`;
}

get answerCountClass() {
    return this.isAnswerOverLimit ? 'char-count char-count--over' : 'char-count';
}

    // ── Match quality label (derived from numeric score) ─────────────────────

    get matchQualityLabel() {
        switch (this.currentMatch?.matchQuality) {
            case 'exact':         return 'Exact Match';
            case 'strong_partial':return 'Strong Match';
            case 'weak_partial':  return 'Partial Match';
            case 'no_match':      return 'Low Match';
            default:              return '';
        }
    }

    get matchQualityClass() {
        switch (this.currentMatch?.matchQuality) {
            case 'exact':         return 'match-quality-badge match-quality--exact';
            case 'strong_partial':return 'match-quality-badge match-quality--strong';
            case 'weak_partial':  return 'match-quality-badge match-quality--partial';
            case 'no_match':      return 'match-quality-badge match-quality--low';
            default:              return '';
        }
    }

    // ── Match details collapse ────────────────────────────────────────────────

    toggleMatchDetails() {
        this.matchDetailsOpen = !this.matchDetailsOpen;
    }

    get matchDetailsChevronClass() {
        return this.matchDetailsOpen ? 'md-chevron md-chevron--open' : 'md-chevron';
    }

    // ── Question navigation ──────────────────────────────────────────────────

    get filteredQuestions() {
        const rawTerm = (this.questionSearchTerm || '').trim();
        const isNumeric = /^\d+$/.test(rawTerm);
        const term = rawTerm.toLowerCase();

        const filtered = this.allQuestions.filter(q => {
            const statusOk = this.statusFilter === 'All'
                || (this.statusFilter === 'Finalised' && q.status === 'Completed')
                || (this.statusFilter === 'Not Finalised' && q.status !== 'Completed')
                || (this.statusFilter === 'Starred' && q.isStarred === true);
            const sectionOk = this.sectionFilter === 'All' || q.section === this.sectionFilter;
            // A plain number is treated as "go to question N", not a text
            // filter, so it should not narrow this list down.
            const searchOk = isNumeric || !term || (q.questionText || '').toLowerCase().includes(term);
            return statusOk && sectionOk && searchOk;
        });

        // Group by section, preserving the section's first appearance order
        const sectionOrder = [];
        const seen = new Set();
        this.allQuestions.forEach(q => {
            const s = q.section || '';
            if (!seen.has(s)) { seen.add(s); sectionOrder.push(s); }
        });

        return [...filtered].sort((a, b) => {
            const si = sectionOrder.indexOf(a.section || '');
            const sj = sectionOrder.indexOf(b.section || '');
            if (si !== sj) return si - sj;
            // Within same section keep original allQuestions order
            return this.allQuestions.indexOf(a) - this.allQuestions.indexOf(b);
        });
    }

    get sectionOptions() {
        const seen = new Set();
        const opts = [{ label: 'All Sections', value: 'All' }];
        this.allQuestions.forEach(q => {
            if (q.section && !seen.has(q.section)) {
                seen.add(q.section);
                opts.push({ label: q.section, value: q.section });
            }
        });
        return opts;
    }

    get statusLabel() {
        return this.statusFilter === 'All' ? 'All Questions' : this.statusFilter;
    }

    get sectionLabel() {
        return this.sectionFilter === 'All' ? 'All Sections' : this.sectionFilter;
    }

    get hasQuestions() {
        return !this.numberNotFound && this.filteredQuestions.length > 0;
    }

    get currentQuestion() {
        return this.filteredQuestions[this.currentIndex];
    }

    get hasAssignedTo() {
        const q = this.currentQuestion;
        return !!(q && q.assignedToName);
    }

    get hasTeamUserResults() {
        return this.teamUserResults && this.teamUserResults.length > 0;
    }


    get notCurrentQuestionComplete() { return !this.isCurrentQuestionComplete; }
    get noSummaryRows() { return !this.hasSummaryRows; }
    get noFilteredCompanyOpts() { return !this.hasFilteredCompanyOpts; }
    get noFilteredConsultingFirmOpts() { return !this.hasFilteredConsultingFirmOpts; }
    get noFilteredIndustryOpts() { return !this.hasFilteredIndustryOpts; }
    get noFilteredFileNameOpts() { return !this.hasFilteredFileNameOpts; }
    get noFilteredRfpNameOpts() { return !this.hasFilteredRfpNameOpts; }
    get noFilteredSvpNameOpts() { return !this.hasFilteredSvpNameOpts; }
    get noFilteredTopicAreaOpts() { return !this.hasFilteredTopicAreaOpts; }
    get questionHasNoTable() { return !this.questionHasTable; }
    get noFinalAnswer() { return !this.hasFinalAnswer; }
    get noActiveFilters() { return !this.hasActiveFilters; }
    get noQuestions() { return !this.hasQuestions; }
    get notRerunning() { return !this.isRerunning; }
    get notEditAILoading() { return !this.isEditAILoading; }
    get notStrategyLoading() { return !this.isStrategyLoading; }
    get notStyleLoading() { return !this.isStyleLoading; }

    get positionLabel() {
        return `Question ${this.currentIndex + 1} of ${this.filteredQuestions.length}`;
    }

    get displayNumber() {
        const q = this.currentQuestion;
        return q?.questionNumber != null ? q.questionNumber : this.currentIndex + 1;
    }

    get isFirst() { return this.currentIndex === 0; }
    get isLast() { return this.currentIndex >= this.filteredQuestions.length - 1; }

    // ── Match filtering ──────────────────────────────────────────────────────

    get filteredMatches() {
        // When any filter is active, _runFilteredSearch already fetched results scoped to
        // those filters from Data Cloud — return them directly.  Applying a second exact-
        // match pass here would incorrectly drop records whose DC field values differ
        // slightly in formatting from the dropdown value (e.g. trailing spaces, case).
        if (this._hasActiveMatchFilters()) {
            return this.currentMatches;
        }
        return this.currentMatches.filter(m => {
            if (this.filterCompany && m.company !== this.filterCompany) return false;
            if (this.filterConsultingFirm && m.consultingFirm !== this.filterConsultingFirm) return false;
            if (this.filterIndustry && m.industry !== this.filterIndustry) return false;
            if (this.filterFileName && m.fileName !== this.filterFileName) return false;
            if (this.filterRfpName && m.rfp !== this.filterRfpName) return false;
            if (this.filterSvpName && m.svpName !== this.filterSvpName) return false;
            if (this.filterTopicArea && m.topicArea !== this.filterTopicArea) return false;
            return true;
        });
    }

    get hasFilteredMatches() { return this.filteredMatches.length > 0; }
    get showMatches() { return !this.isLoadingMatches && this.hasFilteredMatches; }
    get showNoMatches() { return !this.isLoadingMatches && !this.hasFilteredMatches; }


    get currentMatch() { return this.filteredMatches[this.matchIndex]; }

    get matchesFoundLabel() {
        const n = this.filteredMatches.length;
        return `${n} match${n !== 1 ? 'es' : ''} found. Review and select as pertinent.`;
    }

    get matchPositionLabel() {
        return `${this.matchIndex + 1} of ${this.filteredMatches.length}`;
    }

    get isFirstMatch() { return this.matchIndex === 0; }
    get isLastMatch() { return this.matchIndex >= this.filteredMatches.length - 1; }

    // ── Active filter chips ──────────────────────────────────────────────────

    get activeFilterTags() {
        const tags = [];
        if (this.filterCompany) tags.push({ key: 'company', label: `Company: ${this.filterCompany}` });
        if (this.filterConsultingFirm) tags.push({ key: 'consultingFirm', label: `Firm: ${this.filterConsultingFirm}` });
        if (this.filterIndustry) tags.push({ key: 'industry', label: `Industry: ${this.filterIndustry}` });
        if (this.filterFileName) tags.push({ key: 'fileName', label: `File: ${this.filterFileName}` });
        if (this.filterRfpName) tags.push({ key: 'rfpName', label: `RFP: ${this.filterRfpName}` });
        if (this.filterSvpName) tags.push({ key: 'svpName', label: `SVP: ${this.filterSvpName}` });
        if (this.filterTopicArea) tags.push({ key: 'topicArea', label: `Topic: ${this.filterTopicArea}` });
        return tags;
    }

    get hasActiveFilters() { return this.activeFilterTags.length > 0; }

    // ── Handlers ────────────────────────────────────────────────────────────

    toggleSearchPanel() {
        this.showSearchPanel = !this.showSearchPanel;
    }

    // ── Lookup filter handlers ───────────────────────────────────────────────

    handleLookupFocus(event) {
        this.openDropdown = event.currentTarget.dataset.field;
        this.dropdownSearch = '';
    }

    handleLookupInput(event) {
        this.dropdownSearch = event.target.value;
    }

    handleLookupBlur(event) {
        const field = event.currentTarget.dataset.field;
        // Delay so onmousedown on an option fires before blur closes the list
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        window.setTimeout(() => {
            if (this.openDropdown === field) {
                this.openDropdown = null;
                this.dropdownSearch = '';
            }
        }, 200);
    }

    handleLookupSelect(event) {
        const field = event.currentTarget.dataset.field;
        const value = event.currentTarget.dataset.value;
        this._setFilter(field, value);
        this.openDropdown = null;
        this.dropdownSearch = '';
    }

    handleLookupClear(event) {
        const field = event.currentTarget.dataset.field;
        this._setFilter(field, '');
        this.openDropdown = null;
        this.dropdownSearch = '';
    }

    _setFilter(field, value) {
        const map = {
            company: 'filterCompany',
            consultingFirm: 'filterConsultingFirm',
            fileName: 'filterFileName',
            industry: 'filterIndustry',
            rfpName: 'filterRfpName',
            svpName: 'filterSvpName',
            topicArea: 'filterTopicArea'
        };
        if (map[field] !== undefined) {
            this[map[field]] = value;
            this.matchIndex = 0;
            this._resetAnswerView();
            // Re-run the search scoped to active filters
            this.loadMatchesForQuestion();
        }
    }

    // ── Per-field lookup getters ─────────────────────────────────────────────

    _filteredOpts(field) {
        const vals = (this.repositoryOptions || {})[field] || [];
        const term = (this.openDropdown === field ? this.dropdownSearch : '').toLowerCase().trim();
        return term ? vals.filter(v => v.toLowerCase().includes(term)) : vals;
    }

    get isCompanyOpen() { return this.openDropdown === 'company'; }
    get filteredCompanyOpts() { return this._filteredOpts('company'); }
    get hasFilteredCompanyOpts() { return this.filteredCompanyOpts.length > 0; }

    get isConsultingFirmOpen() { return this.openDropdown === 'consultingFirm'; }
    get filteredConsultingFirmOpts() { return this._filteredOpts('consultingFirm'); }
    get hasFilteredConsultingFirmOpts() { return this.filteredConsultingFirmOpts.length > 0; }

    get isFileNameOpen() { return this.openDropdown === 'fileName'; }
    get filteredFileNameOpts() { return this._filteredOpts('fileName'); }
    get hasFilteredFileNameOpts() { return this.filteredFileNameOpts.length > 0; }

    get isIndustryOpen() { return this.openDropdown === 'industry'; }
    get filteredIndustryOpts() { return this._filteredOpts('industry'); }
    get hasFilteredIndustryOpts() { return this.filteredIndustryOpts.length > 0; }

    get isRfpNameOpen() { return this.openDropdown === 'rfpName'; }
    get filteredRfpNameOpts() { return this._filteredOpts('rfpName'); }
    get hasFilteredRfpNameOpts() { return this.filteredRfpNameOpts.length > 0; }

    get isSvpNameOpen() { return this.openDropdown === 'svpName'; }
    get filteredSvpNameOpts() { return this._filteredOpts('svpName'); }
    get hasFilteredSvpNameOpts() { return this.filteredSvpNameOpts.length > 0; }

    get isTopicAreaOpen() { return this.openDropdown === 'topicArea'; }
    get filteredTopicAreaOpts() { return this._filteredOpts('topicArea'); }
    get hasFilteredTopicAreaOpts() { return this.filteredTopicAreaOpts.length > 0; }

    clearFilters() {
        this.filterCompany = '';
        this.filterConsultingFirm = '';
        this.filterIndustry = '';
        this.filterFileName = '';
        this.filterRfpName = '';
        this.filterSvpName = '';
        this.filterTopicArea = '';
        this.matchIndex = 0;
        this._resetAnswerView();
        // Restore original (unfiltered) results from cache
        this.loadMatchesForQuestion();
    }

    removeFilter(event) {
        const key = event.currentTarget.dataset.key;
        const propMap = {
            company: 'filterCompany',
            consultingFirm: 'filterConsultingFirm',
            industry: 'filterIndustry',
            fileName: 'filterFileName',
            rfpName: 'filterRfpName',
            svpName: 'filterSvpName',
            topicArea: 'filterTopicArea'
        };
        if (propMap[key]) {
            this[propMap[key]] = '';
            this.matchIndex = 0;
            this._resetAnswerView();
            // Re-run with remaining filters, or restore from cache if none left
            this.loadMatchesForQuestion();
        }
    }

    handlePrevMatch() { if (!this.isFirstMatch) { this.matchIndex--; this._resetAnswerView(); } }
    handleNextMatch() { if (!this.isLastMatch) { this.matchIndex++; this._resetAnswerView(); } }

    // ── Review mode actions ──────────────────────────────────────────────────

    handleSelectAnswer() {
        if (this.isLockedByOther) return;   // view-only
        this.selectedMatch = this.currentMatch;
        // this.editAnswer = this.currentMatch?.answer || '';
        this.editAnswer = this.currentQuestion?.finalAnswer || this.currentMatch?.answer || '';
        this._editBaseline = this.editAnswer;
        this._styleApplied = this.currentQuestion?.isStyled === true;
        this._matchUsed = true;   // came from a repository match
        this._captureProgressBaseline();
        this.isEditing = true;
        this.rteReadOnly = false;
        this.showSearchPanel = false;
        this.isCompleted = this.currentQuestion?.status === 'Completed';

        const questionId = this.currentQuestion?.id;
        const answerId = this.currentMatch?.id;
        if (questionId && answerId) {
            markSelectedAnswer({ questionId, answerId })
                .then(() => {
                    const updated = this.currentMatches.map(m => ({ ...m, isSelected: m.id === answerId }));
                    this.currentMatches = updated;
                    this.matchesCache[questionId] = updated;
                })
                .catch(error => this._showToast('Error', this._extractError(error), 'error'));
        }
    }

    handleDraftNew() {
        if (this.isLockedByOther) return;   // view-only
        this.selectedMatch = null;
        // Pre-fill with any finalised/draft answer already saved on the question
        this.editAnswer = this.currentQuestion?.finalAnswer || '';
        this._editBaseline = this.editAnswer;
        this._styleApplied = this.currentQuestion?.isStyled === true;
        this._matchUsed = false;   // fresh draft, no match used
        this._captureProgressBaseline();
        this.isEditing = true;
        this.rteReadOnly = false;   // new draft starts editable
        this.showSearchPanel = false;
        this.isCompleted = this.currentQuestion?.status === 'Completed';
    }

    // ── Edit mode actions ────────────────────────────────────────────────────

   handleAnswerChange(event) {
    this.editAnswer = event.detail.value;

    const over = this.isAnswerOverLimit;
    if (over && !this._wasOverAnswerLimit) {
        this._showToast(
            'Warning',
            `Answer limit exceeded. Only ${this.answerWordLimit} words allowed.`,
            'warning'
        );
    }
    this._wasOverAnswerLimit = over;
}

    // True when the answer differs from the baseline captured on entry / last save
    get _isDirty() {
        return (this.editAnswer || '') !== (this._editBaseline || '');
    }

    // Back arrow / Back button → confirm if there are unsaved edits
    handleCancelEdit() {
        if (this._isDirty && !this.isCompleted) {
            this.showUnsavedConfirm = true;
            return;
        }
        this._doCancelEdit();
    }

    // Actually exit edit mode (no guard)
    _doCancelEdit() {
        this.isEditing = false;
        this.selectedMatch = null;
        this.editAnswer = '';
        this.rteReadOnly = true;
        this.isCompleted = false;
        this._editBaseline = '';
        this._matchUsed = false;   // reset session origin
        this._resetAnswerView();
    }

    // Unsaved dialog → Discard & go back — also rolls back styled / strategy
    // progress made during this (unsaved) edit session.
    handleConfirmDiscard() {
        this.showUnsavedConfirm = false;
        this._revertSessionProgress();
        this._doCancelEdit();
    }

    // Unsaved dialog → Keep editing
    handleKeepEditing() {
        this.showUnsavedConfirm = false;
    }

    // Capture the styled / strategy state at the moment the editor opens, so a
    // discard can restore exactly this baseline. Also resets the session tracker.
    _captureProgressBaseline() {
        this._baselineStyled = this.currentQuestion?.isStyled === true;
        this._baselineStrategy = this.currentQuestion?.strategyApplied === true;
        this._sessionAppliedActions = new Set();   // fresh session — nothing applied yet
    }

    // Roll the pipeline back to the captured baseline — in-memory AND on the
    // record. Only clears the style/strategy actions that were applied during
    // THIS session, so previously-saved progress on the question stays intact.
    _revertSessionProgress() {
        const questionId = this.currentQuestion?.id;

        const actionsToUnmark = ['style', 'strategy']
            .filter(a => this._sessionAppliedActions.has(a));

        // Restore client state to the baseline
        this._styleApplied = this._baselineStyled;
        if (questionId) {
            this.allQuestions = this.allQuestions.map(q =>
                q.id === questionId
                    ? { ...q, isStyled: this._baselineStyled, strategyApplied: this._baselineStrategy }
                    : q
            );

            // Clear the flags on the record so they don't come back on refresh
            if (actionsToUnmark.length > 0) {
                unmarkActionApplied({ questionId, actions: actionsToUnmark })
                    .catch(error => console.error('unmarkActionApplied failed', error));
            }
        }
        this._sessionAppliedActions = new Set();
    }

    // Pencil → unlock the editor for typing
    handleEnableEditing() {
        if (this.isCompleted) return;   // no edit access once completed
        this.rteReadOnly = false;
    }

    // Close (X) → lock the editor again (stay in edit view, read-only)
    handleCloseEditing() {
        this.rteReadOnly = true;
    }
    
    get matchDetailPills() {
    const m = this.currentMatch || {};
    return [m.company, m.consultingFirm, m.rfp, m.effectivePeriod, m.industry, m.svpName]
        .filter(v => v != null && String(v).trim() !== '')
        .map((value, i) => ({ key: 'pill' + i, value }));
}

    handleSaveAsDraft() {
        this._persistAnswer('Draft', 'Draft Saved.', false);
    }

    // Mark as Complete opens the confirmation dialog first
    handleMarkComplete() {
        if (!this._styleApplied) {
            this._showToast(
                'Style Required',
                'Please apply Style to this answer before marking it as complete.',
                'warning'
            );
            return;
        }
        this.showCompleteConfirm = true;
    }

    cancelMarkComplete() {
        this.showCompleteConfirm = false;
    }

    confirmMarkComplete() {
        this.showCompleteConfirm = false;
        this._persistAnswer('Completed', 'Answer is finalised and saved.', true);
    }

    _persistAnswer(status, successMsg, lockAfter) {
        const questionId = this.currentQuestion?.id;
        if (!questionId || this.isSaving) return;

        this.isSaving = true;

        saveAnswer({ questionId, answer: this.editAnswer, status, matchUsed: this._matchUsed })
            .then(() => {
                // Immutable update — wire data is read-only, so rebuild the
                // array instead of mutating the object in place.
                this.allQuestions = this.allQuestions.map(q =>
                    q.id === questionId
                        ? {
                            ...q, status, finalAnswer: this.editAnswer, isStyled: this._styleApplied,
                            matchUsed: this._matchUsed,
                            isStarred: status === 'Completed' ? false : q.isStarred
                        }
                        : q
                );

                // Saved → this is now the clean baseline (both text and progress),
                // so nothing is pending discard anymore.
                this._editBaseline = this.editAnswer;
                this._captureProgressBaseline();

                this._showToast('Success', successMsg, 'success');

                if (lockAfter) {
                    // Finalised — nothing left to do here, so return to the
                    // review screen where the completed badge shows.
                    this._doCancelEdit();
                }
            })
            .catch(error => {
                this._showToast('Error', this._extractError(error), 'error');
            })
            .finally(() => {
                this.isSaving = false;
            });
    }

    _showToast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }

    // Pulls a readable message out of any Apex / LDS error shape.
    _extractError(error) {
        if (Array.isArray(error?.body)) {
            return error.body.map(e => e.message).join(', ');
        }
        return error?.body?.message || error?.message || 'Something went wrong. Please try again.';
    }

    // True when the answer contains manual rich-text formatting (bold, italic, underline, etc.)
    _hasRichFormatting() {
        if (!this.editAnswer) return false;
        return /<(b|i|u|strong|em|span)[^>]*>/i.test(this.editAnswer);
    }

    // True when a rich-text value has no actual text (only tags / whitespace)
    _isBlank(html) {
        if (!html) return true;
        return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim() === '';
    }

    // ── AI feedback thumbs ────────────────────────────────────────────────────
    // Each of the three AI modals (Style / Strategy / Edit-with-AI) carries its own
    // thumbs-up / thumbs-down. A click writes one QnA_AI_Feedback__c row per modal
    // session; flipping the rating in the same modal updates that same row.

    // Optional "why?" comment box shown after a thumbs-down.
    showDislikeComment = false;   // controls the comment modal
    dislikeComment = '';          // textarea value
    _dislikeSource = null;        // which source is being commented on

    handleStyleThumb(event) {
        const rating = event.currentTarget.dataset.rating;
        this.styleFeedbackRating = rating;
        this._saveThumb('Style', rating, this.styledAnswerResult, this._styleFeedbackId,
            id => { this._styleFeedbackId = id; },
            () => { this.styleFeedbackRating = undefined; });
    }

    handleStrategyThumb(event) {
        const rating = event.currentTarget.dataset.rating;
        this.strategyFeedbackRating = rating;
        this._saveThumb('Strategy', rating, this.strategyAnswer, this._strategyFeedbackId,
            id => { this._strategyFeedbackId = id; },
            () => { this.strategyFeedbackRating = undefined; });
    }

    handleEditAiThumb(event) {
        const rating = event.currentTarget.dataset.rating;
        this.editaiFeedbackRating = rating;
        this._saveThumb('Edit with AI', rating, this.aiRevisedAnswer, this._editaiFeedbackId,
            id => { this._editaiFeedbackId = id; },
            () => { this.editaiFeedbackRating = undefined; });
    }

    // Saves the rating immediately (comment stays null for now). On a thumbs-down,
    // opens the optional comment box so the user can add a reason if they want.
    _saveThumb(source, rating, answerText, existingId, onOk, onFail) {
        saveFeedback({
            questionId: this.currentQuestion?.id,
            source,
            rating,
            answerText,
            comment: null,
            existingId
        })
            .then(id => {
                onOk(id);
                if (rating === 'Thumbs Down') {
                    // Don't toast yet — prompt for an optional reason first
                    this._dislikeSource = source;
                    this.dislikeComment = '';
                    this.showDislikeComment = true;
                } else {
                    this._showToast('Success', 'Thank you for your feedback', 'success');
                }
            })
            .catch(error => {
                onFail();
                this._showToast('Error', this._extractError(error), 'error');
            });
    }

    handleDislikeCommentChange(event) {
        // Plain <textarea> uses event.target.value (lightning-textarea used detail.value)
        this.dislikeComment = event.target.value;
    }

    get dislikeCommentCount() {
        return (this.dislikeComment || '').length;
    }

    // Close → dismiss without a comment (rating is already saved). No toast here —
    // the thank-you toast only fires on Submit.
    handleDislikeCommentSkip() {
        this.showDislikeComment = false;
        this._dislikeSource = null;
        this.dislikeComment = '';
    }

    // Submit → update the same feedback row with the typed comment
    handleDislikeCommentSubmit() {
        const source = this._dislikeSource;
        if (!source) { this.handleDislikeCommentSkip(); return; }

        // Resolve the saved row id + answer text for whichever source was rated down
        let existingId = null;
        let answerText = '';
        if (source === 'Style') { existingId = this._styleFeedbackId; answerText = this.styledAnswerResult; }
        else if (source === 'Strategy') { existingId = this._strategyFeedbackId; answerText = this.strategyAnswer; }
        else { existingId = this._editaiFeedbackId; answerText = this.aiRevisedAnswer; }

        saveFeedback({
            questionId: this.currentQuestion?.id,
            source,
            rating: 'Thumbs Down',
            answerText,
            comment: this.dislikeComment || null,
            existingId
        })
            .then(id => {
                if (source === 'Style') this._styleFeedbackId = id;
                else if (source === 'Strategy') this._strategyFeedbackId = id;
                else this._editaiFeedbackId = id;
                this._showToast('Success', 'Thank you for your feedback', 'success');
            })
            .catch(error => this._showToast('Error', this._extractError(error), 'error'))
            .finally(() => {
                this.showDislikeComment = false;
                this._dislikeSource = null;
                this.dislikeComment = '';
            });
    }

    _resetStyleFeedback() { this.styleFeedbackRating = undefined; this._styleFeedbackId = null; }
    _resetStrategyFeedback() { this.strategyFeedbackRating = undefined; this._strategyFeedbackId = null; }
    _resetEditAiFeedback() { this.editaiFeedbackRating = undefined; this._editaiFeedbackId = null; }

    get styleThumbUpClass() { return this.styleFeedbackRating === 'Thumbs Up' ? 'fb-thumb fb-thumb--up-on' : 'fb-thumb'; }
    get styleThumbDownClass() { return this.styleFeedbackRating === 'Thumbs Down' ? 'fb-thumb fb-thumb--down-on' : 'fb-thumb'; }
    get strategyThumbUpClass() { return this.strategyFeedbackRating === 'Thumbs Up' ? 'fb-thumb fb-thumb--up-on' : 'fb-thumb'; }
    get strategyThumbDownClass() { return this.strategyFeedbackRating === 'Thumbs Down' ? 'fb-thumb fb-thumb--down-on' : 'fb-thumb'; }
    get editaiThumbUpClass() { return this.editaiFeedbackRating === 'Thumbs Up' ? 'fb-thumb fb-thumb--up-on' : 'fb-thumb'; }
    get editaiThumbDownClass() { return this.editaiFeedbackRating === 'Thumbs Down' ? 'fb-thumb fb-thumb--down-on' : 'fb-thumb'; }

    // ── Edit-with-AI flow ────────────────────────────────────────────────────

    // Edit button → open the instructions modal (guard: answer must exist)
 handleEditWithAI() {
    if (this._isBlank(this.editAnswer)) {
        this._showToast('Error', 'Add an answer before editing with AI.', 'error');
        return;
    }
    this.editInstructions = '';
    this.showEditAIInstructions = true;
}

    handleEditInstructionsChange(event) {
        this.editInstructions = event.detail.value;
    }

    handleCancelEditAI() {
        this.showEditAIInstructions = false;
        this.editInstructions = '';
    }

    // Revise → guard on instructions, then call QA_Edit_With_AI
    handleReviseEditAI() {
        if (this._isBlank(this.editInstructions)) {
            this._showToast('Error', 'Please enter instructions before proceeding.', 'warning');
            return;
        }
        if (this.isEditAILoading) return;

        this.isEditAILoading = true;
        editWithAI({
            questionId: this.currentQuestion?.id,
            answer: this.editAnswer,
            instructions: this.editInstructions
        })
            .then(revised => {
                this.aiRevisedAnswer = revised;
                this._resetEditAiFeedback();   // fresh thumbs for this new result
                this.showEditAIInstructions = false;
                this.showEditAIResult = true;
            })
            .catch(error => {
                this._showToast('Error', this._extractError(error), 'error');
            })
            .finally(() => {
                this.isEditAILoading = false;
            });
    }

    handleAiRevisedChange(event) {
        this.aiRevisedAnswer = event.detail.value;
    }

    // Go Back → return to the instructions modal (keeps typed instructions)
    handleGoBackEditAI() {
        this.showEditAIResult = false;
        this.showEditAIInstructions = true;
    }

    // Apply Changes → push revised text into the editor
    handleApplyAIChanges() {
        this.editAnswer = this.aiRevisedAnswer;
        this.rteReadOnly = false;
        this.showEditAIResult = false;
        this.aiRevisedAnswer = '';
        this.editInstructions = '';
        this._markApplied('edit');
    }

    // ── Style flow: confirm → call QA_Style_Answer → red/green diff modal ──────

    get isAiLoading() {
        return this.isStyleLoading || this.isStrategyLoading;
    }
    get aiLoadingMessage() {
    if (this.isStyleLoading) return 'Styling your answer…';
    if (this.isStrategyLoading) return 'Re-drafting your response to reflect the Strategy…';
    return '';
}

    get isStyleDisabled() {
        return this.isCompleted || this.isStyleLoading;
    }

    // eye toggle icon state
    get styleDiffIconClass() {
        return this.showStyleDiffView ? 'diff-eye diff-eye--active' : 'diff-eye';
    }

    // eye glyph: slashed eye (hidden) while diff is off, open eye once it's shown
    get styleDiffIcon() {
        return this.showStyleDiffView ? 'utility:preview' : 'utility:hide';
    }

    get isCurrentStarred() {
        return this.currentQuestion?.isStarred === true;
    }
    get starIconName() {
        return this.isCurrentStarred ? 'utility:favorite' : 'utility:favorite_alt';
    }
    get starButtonClass() {
        return this.isCurrentStarred ? 'star-btn star-btn--on' : 'star-btn';
    }
    get starTitle() {
        return 'Click to earmark this question';
    }

    handleToggleStar() {
        if (this.isLockedByOther) return;   // view-only
        const q = this.currentQuestion;
        if (!q || !q.id) return;
        const questionId = q.id;
        const newVal = !(q.isStarred === true);

        // Optimistic update
        this.allQuestions = this.allQuestions.map(x =>
            x.id === questionId ? { ...x, isStarred: newVal } : x
        );

        toggleStar({ questionId, starred: newVal })
            .catch(error => {
                // Revert on failure
                this.allQuestions = this.allQuestions.map(x =>
                    x.id === questionId ? { ...x, isStarred: !newVal } : x
                );
                this._showToast('Error', this._extractError(error), 'error');
            });
    }

   handleStyle() {
    if (this._isBlank(this.editAnswer)) {
        this._showToast('Error', 'Add an answer before applying style.', 'error');
        return;
    }
    this.showStyleConfirm = true;
}
    // Confirmation → Go back
    handleStyleGoBack() {
        this.showStyleConfirm = false;
    }

    // Confirmation → Continue: call Apex, build the diff, open the diff modal
    handleStyleContinue() {
        this.showStyleConfirm = false;
        if (this.isStyleLoading) return;

        this.isStyleLoading = true;
        styleAnswer({ questionId: this.currentQuestion?.id, answer: this.editAnswer })
            .then(styled => {
                this.styledAnswerResult = styled;
                const d = this._generateDiff(this.editAnswer, styled);
                this.diffedFinalAnswer = d.removed;
                this.diffedStyled = d.added;
                this.showStyleDiffView = false;  // start in plain view — eye toggles the diff on
                this._resetStyleFeedback();      // fresh thumbs for this new result
                this.showStyleDiff = true;
            })
            .catch(error => {
                this._showToast('Error', this._extractError(error), 'error');
            })
            .finally(() => {
                this.isStyleLoading = false;
            });
    }

    // Eye icon → flip between red/green diff and plain styled text
    toggleStyleDiffView() {
        this.showStyleDiffView = !this.showStyleDiffView;
    }

    // Diff modal → Cancel: discard the styled result, keep the original
    handleStyleCancel() {
        this.showStyleDiff = false;
        this.showStyleDiffView = false;   // reset so the next open starts plain (eye closed)
        this.styledAnswerResult = '';
        this.diffedFinalAnswer = '';
        this.diffedStyled = '';
    }

    // Diff modal → Apply Changes: push styled text into the editor (no record save)
    handleApplyStyle() {
        this.editAnswer = this.styledAnswerResult;
        this.rteReadOnly = false;
        this.showStyleDiff = false;
        this.showStyleDiffView = false;   // reset so the next open starts plain (eye closed)
        this.styledAnswerResult = '';
        this.diffedFinalAnswer = '';
        this.diffedStyled = '';
        this._markApplied('style');
        this._styleApplied = true;
    }

    // ── Diff helpers (ported from AiReview2 / DiffLib) ─────────────────────────

    _generateDiff(baseText, updatedText) {
        if (!this._diffLibLoaded || !window.Diff || !window.Diff.diffWordsWithSpace) {
            // Library not ready — show plain text, no highlighting
            return { removed: baseText || '', added: updatedText || '' };
        }
        const parts = window.Diff.diffWordsWithSpace(baseText || '', updatedText || '');
        return {
            removed: this._formatRemoved(parts),
            added: this._formatAdded(parts)
        };
    }

   _formatRemoved(parts) {
    return parts.map(part => {
        if (part.removed) {
            return `<span style="background-color:#f3a6a6;">${part.value}</span>`;
        } else if (!part.added) {
            return `<span>${part.value}</span>`;
        }
        return '';
    }).join('');
}

    _formatAdded(parts) {
        return parts.map(part => {
            if (part.added) {
                return `<span style="background-color:#a6f3a6;">${part.value}</span>`;
            } else if (!part.removed) {
                return `<span>${part.value}</span>`;
            }
            return '';
        }).join('');
    }

    // ── Apply Strategy ─────────────────────────────────────────────────────────

    get hasStrategyReasoning() {
        return this.strategyReasoning && this.strategyReasoning.length > 0;
    }

    // eye toggle icon state (strategy modal)
    get strategyDiffIconClass() {
        return this.showStrategyDiffView ? 'diff-eye diff-eye--active' : 'diff-eye';
    }

    // eye glyph: slashed eye (hidden) while diff is off, open eye once it's shown
    get strategyDiffIcon() {
        return this.showStrategyDiffView ? 'utility:preview' : 'utility:hide';
    }

   handleStrategizeAnswer() {
    const questionId = this.currentQuestion?.id;
    if (!questionId || this.isStrategyLoading) return;

    if (this._isBlank(this.editAnswer)) {
        this._showToast('Error', 'Add an answer before applying strategy.', 'error');
        return;
    }

    if (this._styleApplied || this._hasRichFormatting()) {
        this.showStyleOverwriteWarning = true;
        return;
    }

    this._proceedWithStrategy(questionId);
}

    handleStyleOverwriteConfirm() {
        this.showStyleOverwriteWarning = false;
        this._proceedWithStrategy(this.currentQuestion?.id);
    }

    handleStyleOverwriteCancel() {
        this.showStyleOverwriteWarning = false;
    }

    _proceedWithStrategy(questionId) {
        if (!questionId) return;
        this.originalAnswerSnapshot = this.editAnswer;
        this.isStrategyLoading = true;

        assessStrategyApplicability({ questionId, answer: this.editAnswer })
            .then(raw => {
                let applicable = true;
                let reason = '';
                try {
                    const parsed = JSON.parse(raw);
                    applicable = parsed.applicable !== false;
                    reason = parsed.reason || '';
                } catch (_) {
                    // Unparseable response - proceed with strategy
                }
                if (!applicable) {
                    this.strategySkipReason = reason;
                    this.showStrategySkipConfirm = true;
                    this.isStrategyLoading = false;
                    return;
                }
                this._runApplyStrategy(questionId);
            })
            .catch(error => {
                this._showToast('Error', this._extractError(error), 'error');
                this.isStrategyLoading = false;
            });
    }

    // Called when user clicks "Use Strategy Anyway" after a not-applicable warning
    handleStrategyOverride() {
        const questionId = this.currentQuestion?.id;
        if (!questionId) return;
        this.showStrategySkipConfirm = false;
        this.strategySkipReason = '';
        this.isStrategyLoading = true;
        this._runApplyStrategy(questionId);
    }

    // Called when user clicks "Skip" on the not-applicable warning
    handleStrategySkip() {
        this.showStrategySkipConfirm = false;
        this.strategySkipReason = '';
    }

    _runApplyStrategy(questionId) {
        applyStrategy({ questionId, answer: this.originalAnswerSnapshot })
            .then(raw => {
                try {
                    // Prompt returns JSON: { rewritten_answer, reasoning: [{strategy_point_id, strategy_point, change_made}] }
                    // Strip any markdown code fences the model may wrap around the JSON.
                    const cleaned = String(raw).replace(/```json|```/g, '').trim();
                    const parsed = JSON.parse(cleaned);
                    this.strategyAnswer = parsed.rewritten_answer || cleaned;
                    this.strategyReasoning = (parsed.reasoning || []).map((r, i) => ({
                        ...r,
                        key: r.strategy_point_id || String(i)
                    }));
                } catch (_) {
                    // Fallback: treat whole response as plain answer (no reasoning)
                    this.strategyAnswer = raw;
                    this.strategyReasoning = [];
                }
                // Build red/green diff: original (removals) vs strategy answer (additions)
                const d = this._generateDiff(this.originalAnswerSnapshot, this.strategyAnswer);
                this.diffedStrategyOriginal = d.removed;
                this.diffedStrategy = d.added;
                this.showStrategyDiffView = false;  // start in plain view — eye toggles the diff on
                this._resetStrategyFeedback();      // fresh thumbs for this new result
                this.showStrategyCompare = true;
            })
            .catch(error => {
                this._showToast('Error', this._extractError(error), 'error');
            })
            .finally(() => {
                this.isStrategyLoading = false;
            });
    }

    // Eye icon → flip between red/green diff and plain text
    toggleStrategyDiffView() {
        this.showStrategyDiffView = !this.showStrategyDiffView;
    }

    handleUseOriginalAnswer() {
        this.editAnswer = this.originalAnswerSnapshot;
        this.rteReadOnly = false;
        this.showStrategyCompare = false;
        this.strategyReasoning = [];
        this._resetStrategyDiff();
    }

    handleUseStrategyAnswer() {
        this.editAnswer = this.strategyAnswer;
        this.rteReadOnly = false;
        this.showStrategyCompare = false;
        this.strategyReasoning = [];
        this._resetStrategyDiff();
        this._markApplied('strategy');
    }
    _markApplied(action) {
        const questionId = this.currentQuestion?.id;
        if (!questionId) return;
        // Track for discard rollback (only style/strategy matter for the pipeline)
        this._sessionAppliedActions.add(action);
        markActionApplied({ questionId, action })
            .then(() => {
                this.allQuestions = this.allQuestions.map(q => {
                    if (q.id !== questionId) return q;
                    if (action === 'strategy') return { ...q, strategyApplied: true };
                    if (action === 'style') return { ...q, isStyled: true };
                    return q;
                });
            })
            .catch(error => console.error('markActionApplied failed', error));
    }
    handleDismissStrategyCompare() {
        this.showStrategyCompare = false;
        this.strategyReasoning = [];
        this._resetStrategyDiff();
    }

    _resetStrategyDiff() {
        this.diffedStrategyOriginal = '';
        this.diffedStrategy = '';
        this.showStrategyDiffView = false;
        this.strategyReasoningOpen = false;
    }

    toggleStrategyReasoning() {
        this.strategyReasoningOpen = !this.strategyReasoningOpen;
    }

    get strategyReasoningChevron() {
        return this.strategyReasoningOpen ? 'utility:chevrondown' : 'utility:chevronright';
    }

    handleEditOriginalAnswer() {
        this.editAnswer = this.originalAnswerSnapshot;
        this.rteReadOnly = false;
        this.showStrategyCompare = false;
        this.strategyReasoning = [];
        this._resetStrategyDiff();
    }

    handleEditStrategyAnswer() {
        this.editAnswer = this.strategyAnswer;
        this.rteReadOnly = false;
        this.showStrategyCompare = false;
        this.strategyReasoning = [];
        this._resetStrategyDiff();
        this._markApplied('strategy');
    }

    handleEditCurrentAnswer() {
        this.rteReadOnly = false;
        this.showStyleDiff = false;
        this.showStyleDiffView = false;   // reset so the next open starts plain (eye closed)
        this.styledAnswerResult = '';
        this.diffedFinalAnswer = '';
        this.diffedStyled = '';
    }

    handleEditStyledAnswer() {
        this.editAnswer = this.styledAnswerResult;
        this.rteReadOnly = false;
        this.showStyleDiff = false;
        this.showStyleDiffView = false;   // reset so the next open starts plain (eye closed)
        this.styledAnswerResult = '';
        this.diffedFinalAnswer = '';
        this.diffedStyled = '';
        this._markApplied('style');
    }

    handleCopyText(event) {
        const text = event.currentTarget.dataset.text;
        const plain = text.replace(/<[^>]*>/g, '');
        navigator.clipboard.writeText(plain)
            .then(() => this._showToast('Copied', 'Text copied to clipboard.', 'success'))
            .catch(() => this._showToast('Error', 'Could not copy text.', 'error'));
    }

    // ── Question / filter navigation ─────────────────────────────────────────

    handleStatusSelect(event) {
        this.statusFilter = event.detail.value;
        this.currentIndex = 0;
        this.matchIndex = 0;
        this.loadMatchesForQuestion();
    }

    handleSectionSelect(event) {
        this.sectionFilter = event.detail.value;
        this.currentIndex = 0;
        this.matchIndex = 0;
        this.loadMatchesForQuestion();
    }

    handlePrevious() {
        if (!this.isFirst) {
            this.currentIndex--;
            this.matchIndex = 0;
            this.loadMatchesForQuestion();
        }
    }

    handleNext() {
        if (!this.isLast) {
            this.currentIndex++;
            this.matchIndex = 0;
            this.loadMatchesForQuestion();
        }
    }

    handleBackToDownload() {
        this.showWorkspace = false;
        this.loadStats();          // refresh Total / Finalized / Pending
    }
    handleReopenQuestion() {
        if (this.isLockedByOther) return;   // view-only
        const q = this.currentQuestion;
        if (!q) return;

        if (q.strategyApplied === true) {
            this._showToast('warning', 'Strategy is already applied for this question.', 'warning');
            return;
        }

        const questionId = q.id;
        const answer = q.finalAnswer || '';
        const wasCompleted = q.status === 'Completed';

        const openEditor = () => {
            this.selectedMatch = null;
            this.editAnswer = answer;
            this._editBaseline = answer;
            this._styleApplied = q.isStyled === true;
            this._matchUsed = q.matchUsed === true;   // preserve origin on reopen
            this._captureProgressBaseline();
            this.isEditing = true;
            this.isCompleted = false;   // all buttons enabled
            this.rteReadOnly = false;   // editable
            this.showSearchPanel = false;
        };

        if (wasCompleted) {
            // Status flip only — matchUsed:null so we don't clobber the stored origin
            saveAnswer({ questionId, answer, status: 'Draft', matchUsed: null })
                .then(() => {
                    this.allQuestions = this.allQuestions.map(x =>
                        x.id === questionId ? { ...x, status: 'Draft' } : x
                    );
                    if (this.statusFilter === 'Finalised') this.statusFilter = 'All';
                    const idx = this.filteredQuestions.findIndex(x => x.id === questionId);
                    if (idx !== -1) this.currentIndex = idx;
                    openEditor();
                })
                .catch(error => this._showToast('Error', this._extractError(error), 'error'));
        } else {
            openEditor();   // already editable, no record change needed
        }
    }

    // ── Team Management ───────────────────────────────────────────────────────

    // ── Question Assignment ───────────────────────────────────────────────────


}