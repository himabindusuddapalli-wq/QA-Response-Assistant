import { LightningElement, api, wire } from 'lwc';
import { loadScript } from 'lightning/platformResourceLoader';
import getReviewData from '@salesforce/apex/QnaReviewController.getReviewData';
import getRepositoryFilterOptions from '@salesforce/apex/QnaReviewController.getRepositoryFilterOptions';
import getAnswersForQuestion from '@salesforce/apex/QnaAnswerSearchController.getAnswersForQuestion';
import saveAnswer from '@salesforce/apex/QnaReviewController.saveAnswer';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import applyStrategy from '@salesforce/apex/QnaAIActionsController.applyStrategy';
import assessStrategyApplicability from '@salesforce/apex/QnaAIActionsController.assessStrategyApplicability';
import editWithAI from '@salesforce/apex/QnaAIActionsController.editWithAI';
import styleAnswer from '@salesforce/apex/QnaAIActionsController.styleAnswer';
import DiffLib from '@salesforce/resourceUrl/DiffLib';
import markActionApplied from '@salesforce/apex/QnaAIActionsController.markActionApplied';
import markSelectedAnswer from '@salesforce/apex/QnaReviewController.markSelectedAnswer';

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

    // Unsaved-changes guard
    showUnsavedConfirm = false;   // "discard unsaved changes?" dialog
    _editBaseline = '';           // editAnswer value at the moment editing started

    // Style flow state
    isStyleLoading = false;
    showStyleConfirm = false;     // "about to style" confirmation
    showStyleDiff = false;        // styled-answer modal
    showStyleDiffView = true;     // eye toggle: true = red/green diff, false = plain styled text
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
    showStrategyDiffView = true;   // eye toggle: true = red/green diff, false = plain text
    diffedStrategyOriginal = '';   // left panel: removals struck in red
    diffedStrategy = '';           // right panel: additions in green

    // Strategy applicability check modal state
    showStrategySkipConfirm = false;
    strategySkipReason = '';

    // Edit-with-AI modal state
    showEditAIInstructions = false;   // Instructions modal
    showEditAIResult = false;         // AI Revised Answer modal
    editInstructions = '';
    aiRevisedAnswer = '';
    isEditAILoading = false;
      _styleApplied = false; 

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

    statusOptions = [
        { label: 'All Questions', value: 'All' },
        { label: 'Not Finalised', value: 'Not Finalised' },
        { label: 'Finalised', value: 'Finalised' }
    ];

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    connectedCallback() {
        loadScript(this, DiffLib)
            .then(() => { this._diffLibLoaded = true; })
            .catch(err => console.error('Failed to load DiffLib', err));
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
            this.loadMatchesForQuestion();
        } else if (error) {
            this.error = this._extractError(error);
            this.isLoading = false;
        }
    }

    get showEditButton() {
        return this.strategyMode && !this.isEditing;
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
                const mapped = (records || []).map(r => ({
                    id: r.Id,
                    score: r.Match_Score__c != null ? r.Match_Score__c : '—',
                    rfp: r.RFP_Name__c || '',
                    effectivePeriod: r.Effective_Period__c || '',
                    company: r.Company__c || '',
                    consultingFirm: r.Consulting_Firm__c || '',
                    industry: r.Industry__c || '',
                    fileName: r.File_Name__c || '',
                    svpName: r.SVP_Name__c || '',
                    topicArea: r.Topic_Area__c || '',
                    question: r.D360_Data_Source_ID__c || '',   // matched chunk stored here
                    answer: r.Answer__c || '',
                    isSelected: r.Is_Selected_Answer__c || false
                }));
                this.matchesCache[qId] = mapped;
                this.currentMatches = mapped;
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

    // ── Header ──────────────────────────────────────────────────────────────

    get headerName() {
        return this.membershipActivityName || this.documentName;
    }

    get filterToggleLabel() {
        return this.showSearchPanel ? 'Close Search' : 'Search';
    }

    // ── Footer question search ────────────────────────────────────────────────

    get searchPlaceholder() {
        const n = this.allQuestions.length;
        return `Search all ${n} question${n !== 1 ? 's' : ''}…`;
    }

    get isCurrentQuestionComplete() {
        return this.currentQuestion?.status === 'Completed';
    }
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

        // Plain number entered (e.g. "5") -> jump straight to that question
        // number instead of text-filtering the list by it.
        if (/^\d+$/.test(trimmed)) {
            const num = parseInt(trimmed, 10);
            const list = this.filteredQuestions; // status/section filters still apply, text filter does not (see getter)
            const idx = list.findIndex((q, i) => {
                const displayNum = q.questionNumber != null ? Number(q.questionNumber) : i + 1;
                return displayNum === num;
            });
            if (idx !== -1) {
                this.currentIndex = idx;
                this.matchIndex = 0;
                this._resetAnswerView();
                this.loadMatchesForQuestion();
                return;
            }
            // Number typed but no matching question — leave the view as-is
            // rather than clearing everything out from under the user.
            return;
        }

        this.currentIndex = 0;
        this.matchIndex = 0;
        this._resetAnswerView();
        this.loadMatchesForQuestion();
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

    // ── Match score display ────────────────────────────────────────────────────

    get scoreDisplay() {
        const s = this.currentMatch?.score;
        if (s == null || s === '—') return '—';
        const n = Number(s);
        return Number.isNaN(n) ? String(s) : n.toFixed(2);
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
        return this.allQuestions.filter(q => {
            const statusOk = this.statusFilter === 'All'
                || (this.statusFilter === 'Finalised' && q.status === 'Completed')
                || (this.statusFilter === 'Not Finalised' && q.status !== 'Completed');
            const sectionOk = this.sectionFilter === 'All' || q.section === this.sectionFilter;
            // A plain number is treated as "go to question N", not a text
            // filter, so it should not narrow this list down.
            const searchOk = isNumeric || !term || (q.questionText || '').toLowerCase().includes(term);
            return statusOk && sectionOk && searchOk;
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
        return this.filteredQuestions.length > 0;
    }

    get currentQuestion() {
        return this.filteredQuestions[this.currentIndex];
    }

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
        }
    }

    handlePrevMatch() { if (!this.isFirstMatch) { this.matchIndex--; this._resetAnswerView(); } }
    handleNextMatch() { if (!this.isLastMatch) { this.matchIndex++; this._resetAnswerView(); } }

    // ── Review mode actions ──────────────────────────────────────────────────

    handleSelectAnswer() {
        this.selectedMatch = this.currentMatch;
       // this.editAnswer = this.currentMatch?.answer || '';
       this.editAnswer = this.currentQuestion?.finalAnswer || this.currentMatch?.answer || '';
        this._editBaseline = this.editAnswer;
        this._styleApplied = this.currentQuestion?.isStyled === true;
        this.isEditing = true;
        this.rteReadOnly = false;
        this.showSearchPanel = false;
        this.isCompleted = this.currentQuestion?.status === 'Completed';
       
        const questionId = this.currentQuestion?.id;
        const answerId = this.currentMatch?.id;
        console.log('SELECT CLICK →', questionId, answerId);   // temporary
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
        this.selectedMatch = null;
        // Pre-fill with any finalised/draft answer already saved on the question
        this.editAnswer = this.currentQuestion?.finalAnswer || '';
        this._editBaseline = this.editAnswer;
        this._styleApplied = this.currentQuestion?.isStyled === true;
        this.isEditing = true;
        this.rteReadOnly = false;   // new draft starts editable
        this.showSearchPanel = false;
        this.isCompleted = this.currentQuestion?.status === 'Completed';
    }

    // ── Edit mode actions ────────────────────────────────────────────────────

    handleAnswerChange(event) {
        this.editAnswer = event.detail.value;
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
        this._resetAnswerView();
    }

    // Unsaved dialog → Discard & go back
    handleConfirmDiscard() {
        this.showUnsavedConfirm = false;
        this._doCancelEdit();
    }

    // Unsaved dialog → Keep editing
    handleKeepEditing() {
        this.showUnsavedConfirm = false;
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

        saveAnswer({ questionId, answer: this.editAnswer, status })
            .then(() => {
                // Immutable update — wire data is read-only, so rebuild the
                // array instead of mutating the object in place.
                this.allQuestions = this.allQuestions.map(q =>
                    q.id === questionId ? { ...q, status, finalAnswer: this.editAnswer } : q
                );

                // Saved → this is now the clean baseline
                this._editBaseline = this.editAnswer;

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

    // True when a rich-text value has no actual text (only tags / whitespace)
    _isBlank(html) {
        if (!html) return true;
        return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim() === '';
    }

    // ── Edit-with-AI flow ────────────────────────────────────────────────────

    // Edit button → open the instructions modal (guard: answer must exist)
    handleEditWithAI() {
        if (this._isBlank(this.editAnswer)) {
            this._showToast('Warning', 'Please enter the text.', 'warning');
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
            this._showToast('Warning', 'Please enter instructions before proceeding.', 'warning');
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

    get isStyleDisabled() {
        return this.isCompleted || this.isStyleLoading;
    }

    // eye toggle icon state
    get styleDiffIconClass() {
        return this.showStyleDiffView ? 'diff-eye diff-eye--active' : 'diff-eye';
    }

    // Style button → open the confirmation modal (guard: answer must exist)
    handleStyle() {
        if (this._isBlank(this.editAnswer)) {
            this._showToast('Warning', 'Please enter the text.', 'warning');
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
                this.showStyleDiffView = true;   // start in diff view
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
        this.styledAnswerResult = '';
        this.diffedFinalAnswer = '';
        this.diffedStyled = '';
    }

    // Diff modal → Apply Changes: push styled text into the editor (no record save)
    handleApplyStyle() {
        this.editAnswer = this.styledAnswerResult;
        this.rteReadOnly = false;
        this.showStyleDiff = false;
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
                return `<span style="background-color:#f3a6a6;text-decoration:line-through;">${part.value}</span>`;
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

    handleStrategizeAnswer() {
        const questionId = this.currentQuestion?.id;
        if (!questionId || this.isStrategyLoading) return;

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
                    const parsed = JSON.parse(raw);
                    this.strategyAnswer = parsed.rewritten_answer || raw;
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
                this.showStrategyDiffView = true;   // start in diff view
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
        markActionApplied({ questionId, action })
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
        this.showStrategyDiffView = true;
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
        this.styledAnswerResult = '';
        this.diffedFinalAnswer = '';
        this.diffedStyled = '';
    }

    handleEditStyledAnswer() {
        this.editAnswer = this.styledAnswerResult;
        this.rteReadOnly = false;
        this.showStyleDiff = false;
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
            this.isEditing = true;
            this.isCompleted = false;   // all buttons enabled
            this.rteReadOnly = false;   // editable
            this.showSearchPanel = false;
        };

        if (wasCompleted) {
            saveAnswer({ questionId, answer, status: 'Draft' })
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

}