import { LightningElement } from 'lwc';
import { loadScript } from 'lightning/platformResourceLoader';
import JSZipLib from '@salesforce/resourceUrl/SA_jszip2';
import SHEETJS  from '@salesforce/resourceUrl/ExcelJSFile';
import searchAccounts             from '@salesforce/apex/QaDocUploadController.searchAccounts';
import searchOpportunities        from '@salesforce/apex/QaDocUploadController.searchOpportunities';
import searchRfps                 from '@salesforce/apex/QaDocUploadController.searchRfps';
import getRfpDetails              from '@salesforce/apex/QaDocUploadController.getRfpDetails';
import uploadAndParseQaDocument   from '@salesforce/apex/QaDocUploadController.uploadAndParseQaDocument';
import uploadAndParsePdfDocument  from '@salesforce/apex/QaDocUploadController.uploadAndParsePdfDocument';
import addQuestionsToDocument     from '@salesforce/apex/QaDocUploadController.addQuestionsToDocument';
import attachFileToDocument       from '@salesforce/apex/QaDocUploadController.attachFileToDocument';
import startAnswerSearchBatch     from '@salesforce/apex/QaDocUploadController.startAnswerSearchBatch';
import notifyQuestionsProcessed  from '@salesforce/apex/QaDocUploadController.notifyQuestionsProcessed';
import getOpportunityDetails from '@salesforce/apex/QaDocUploadController.getOpportunityDetails';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';

export default class QaDocUpload extends LightningElement {

  companyId;    companyName = '';
  maId;         maName = '';
  rfpId;        rfpName = '';
  dueDate = '';

  companyOptions = [];
  maOptions      = [];
  rfpOptions     = [];

  fileName;
  fileObj;
  errorMessage = '';
  isUploading      = false;
  isProcessingPdf  = false;
  _uploadCancelled = false;
  _uploadComplete  = false;
  _pollInterval    = null;
  _pdfStatusMessage = '';

  XLSX;
  sheetJsLoaded = false;
  jsZipLoaded   = false;

  // Excel sheet mapping state (populated when an Excel file is selected)
  sheetRenderData  = [];    // [{name, rows, headerRow, headers, mapping, isSelected}]
  showExcelMapping = false;

  headerRowOptions = [
    {label:'1',value:'1'},{label:'2',value:'2'},{label:'3',value:'3'},
    {label:'4',value:'4'},{label:'5',value:'5'},{label:'6',value:'6'},
    {label:'7',value:'7'},{label:'8',value:'8'},{label:'9',value:'9'},
    {label:'10',value:'10'}
  ];

  connectedCallback() {
    if (!this.jsZipLoaded) {
      loadScript(this, JSZipLib)
        .then(() => { this.jsZipLoaded = true; })
        .catch(err => console.error('JSZip load error:', err?.message || String(err)));
    }
    if (!this.sheetJsLoaded) {
      loadScript(this, SHEETJS)
        .then(() => { this.XLSX = window.XLSX; this.sheetJsLoaded = true; })
        .catch(err => console.error('SheetJS load error:', err?.message || String(err)));
    }
  }

  get noFile() { return !this.fileObj; }

  get fileIconLabel() {
    if (!this.fileName) return 'DOC';
    const ext = this.fileName.split('.').pop().toLowerCase();
    if (['xls', 'xlsx'].includes(ext)) return 'XLS';
    if (ext === 'pdf') return 'PDF';
    return 'DOC';
  }

  get fileTypeLabel() {
    if (!this.fileName) return '';
    const ext = this.fileName.split('.').pop().toLowerCase();
    if (['xls', 'xlsx'].includes(ext)) return 'Microsoft Excel';
    if (ext === 'pdf') return 'PDF';
    return 'Microsoft Word';
  }

  get fileSize() {
    if (!this.fileObj) return '';
    const b = this.fileObj.size;
    if (b < 1024)           return b + ' B';
    if (b < 1024 * 1024)    return Math.round(b / 1024) + ' KB';
    return (b / (1024 * 1024)).toFixed(1) + ' MB';
  }

  get showRemoveBtn() {
    return !this.isUploading && !this._uploadComplete;
  }

  get uploadDisabled() {
    if (this.isUploading || this._uploadComplete
        || !(this.companyId || this.maId || this.rfpId)
        || !this.dueDate) return true;
    // For Excel: at least one sheet must be selected with Question Text + Section mapped
    if (this.showExcelMapping) {
      return !this.sheetRenderData.some(
        s => s.isSelected && s.mapping.questionText !== ''
      );
    }
    return false;
  }

  get uploadLabel() {
    if (this.isProcessingPdf) return 'Processing PDF...';
    return this.isUploading ? 'Uploading...' : 'Upload';
  }

  get processingPdfMessage() {
    return this._pdfStatusMessage || 'Uploading PDF...';
  }

  get uploadBtnClass() {
    return this.uploadDisabled ? 'upload-btn upload-btn-off' : 'upload-btn';
  }

  get noRecordSelected() {
    return !(this.companyId || this.maId || this.rfpId);
  }

  get uploadZoneClass() {
    return this.noRecordSelected ? 'upload-zone upload-zone-off' : 'upload-zone';
  }

  // ----- Company (Account) -----
  handleCompanySearch(event) {
    const term = event.target.value;
    this.companyName = term;
    this.companyId   = null;
    this.companyOptions = [];
    // Cascade: clear MA and RFP when company changes
    this.maId = null; this.maName = ''; this.maOptions = [];
    this.rfpId = null; this.rfpName = ''; this.rfpOptions = [];
    if (!term || term.length < 2) return;
    searchAccounts({ term })
      .then(r => { this.companyOptions = r; })
      .catch(() => { this.companyOptions = []; });
  }
  handleCompanyPick(event) {
    this.companyId   = event.currentTarget.dataset.id;
    this.companyName = event.currentTarget.dataset.name;
    this.companyOptions = [];
    // Cascade: clear MA and RFP when a new company is picked
    this.maId = null; this.maName = ''; this.maOptions = [];
    this.rfpId = null; this.rfpName = ''; this.rfpOptions = [];
  }

  // ----- Membership Activity (Opportunity) — filtered by selected Company -----
  handleMaSearch(event) {
    const term = event.target.value;
    this.maName = term;
    this.maId   = null;
    this.maOptions = [];
    // Cascade: clear RFP when MA changes
    this.rfpId = null; this.rfpName = ''; this.rfpOptions = [];
    if (!term || term.length < 2) return;
    searchOpportunities({ term, accountId: this.companyId || null })
      .then(r => { this.maOptions = r; })
      .catch(() => { this.maOptions = []; });
  }
 handleMaPick(event) {
    this.maId   = event.currentTarget.dataset.id;
    this.maName = event.currentTarget.dataset.name;
    this.maOptions = [];
    // Cascade: clear RFP when a new MA is picked
    this.rfpId = null; this.rfpName = ''; this.rfpOptions = [];
    // Auto-populate Company from the selected Membership Activity's Account
    getOpportunityDetails({ maId: this.maId })
        .then(d => {
            if (d && d.companyId) {
                this.companyId   = d.companyId;
                this.companyName = d.companyName;
            }
        })
        .catch(err => console.error('Opportunity details error:', err?.body?.message || err?.message));
}

  // ----- RFP — filtered by selected Membership Activity -----
  handleRfpSearch(event) {
    const term = event.target.value;
    this.rfpName = term;
    this.rfpId   = null;
    this.rfpOptions = [];
    if (!term || term.length < 2) return;
    searchRfps({ term, maId: this.maId || null })
      .then(r => { this.rfpOptions = r; })
      .catch(() => { this.rfpOptions = []; });
  }
  handleRfpPick(event) {
    this.rfpId   = event.currentTarget.dataset.id;
    this.rfpName = event.currentTarget.dataset.name;
    this.rfpOptions = [];
    getRfpDetails({ rfpId: this.rfpId })
      .then(d => {
        if (d.maId)      { this.maId = d.maId;           this.maName = d.maName; }
        if (d.companyId) { this.companyId = d.companyId; this.companyName = d.companyName; }
      })
      .catch(err => console.error('RFP details error:', err?.body?.message || err?.message));
  }

  // ----- Review Due Date -----
  handleDueDateChange(event) {
    this.dueDate = event.target.value;
  }

  // ----- File -----
  handleFile(event) {
    this.errorMessage = '';
    const file = event.target.files[0];
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['doc', 'docx', 'xls', 'xlsx', 'pdf'].includes(ext)) {
      this.errorMessage = 'Only Word, Excel, or PDF files are supported.';
      return;
    }
    if (file.size > 2.5 * 1024 * 1024) {
      this.errorMessage = 'File exceeds the 2.5 MB size limit.';
      return;
    }
    this.fileObj         = file;
    this.fileName        = file.name;
    this.sheetRenderData = [];
    this.showExcelMapping = false;
    if (['xls', 'xlsx'].includes(ext) && this.sheetJsLoaded) {
      this._prepareExcel(file);
    }
  }

  handleRemoveFile() {
    this.fileObj         = null;
    this.fileName        = null;
    this.errorMessage    = '';
    this.sheetRenderData = [];
    this.showExcelMapping = false;
  }

  // ----- Actions -----
  handleClose() {
    this.dispatchEvent(new CustomEvent('close'));
  }

  handleCancelUpload() {
    this._uploadCancelled = true;
    this.isUploading      = false;
    this.isProcessingPdf  = false;
    this._uploadComplete  = false;
    this.fileObj          = null;
    this.fileName         = null;
    this.sheetRenderData  = [];
    this.showExcelMapping = false;
    this.errorMessage     = '';
  }

  // ----- Toast helper (standard Lightning toast) -----
  _showToast(title, message, variant) {
    this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
  }

  async handleUpload() {
    if (!this.fileObj) {
      this.errorMessage = 'Please select a file before uploading.';
      return;
    }
    this._uploadCancelled = false;
    this.isUploading      = true;
    this.errorMessage     = '';

    try {
      const uploadStartTime = Date.now();
      const [base64, arrayBuffer] = await Promise.all([
        this._readAsBase64(this.fileObj),
        this._readAsArrayBuffer(this.fileObj)
      ]);

      if (this._uploadCancelled) return;

      const ext = this.fileName.split('.').pop().toLowerCase();

      // PDF is extracted server-side via Document AI — separate path from
      // the client-side Word/Excel parsing below, which stays untouched.
      if (ext === 'pdf') {
        this.isProcessingPdf = true;
        this._pdfStatusMessage = 'Uploading PDF...';

        let apexError = null;
        let pdfResult = null;

        // Race the upload against a 45-second timeout.
        // The Apex method only saves the file and enqueues a Queueable (no Document AI
        // callout in this transaction), so it should return in a few seconds.
        // If the network stalls on a large file and we hit the timeout, the Queueable
        // is almost certainly already enqueued server-side — fall through to close.
        const TIMEOUT_MS = 45000;
        let didTimeout = false;
        let timeoutHandle;

        const apexPromise = uploadAndParsePdfDocument({
          fileName:   this.fileName,
          companyId:  this.companyId || null,
          maId:       this.maId      || null,
          rfpId:      this.rfpId     || null,
          dueDate:    this.dueDate   || null,
          base64Data: base64
        }).then(r => { pdfResult = r; }).catch(err => { apexError = err; });

        const timeoutPromise = new Promise(resolve => {
          // eslint-disable-next-line @lwc/lwc/no-async-operation
          timeoutHandle = setTimeout(() => { didTimeout = true; resolve(); }, TIMEOUT_MS);
        });

        await Promise.race([apexPromise, timeoutPromise]);
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        clearTimeout(timeoutHandle);

        if (apexError && !didTimeout) {
          this.isProcessingPdf = false;
          this.isUploading = false;
          this.errorMessage = apexError.body ? apexError.body.message : 'Upload failed. Please try again.';
          return;
        }

        if (this._uploadCancelled) return;
        this.isProcessingPdf = false;
        this.isUploading = false;
        this._uploadComplete = true;
        this._showToast('Success', 'File uploaded. Extraction and answer matching are running in the background — you\'ll receive an email when complete.', 'success');
        const pdfDocId = pdfResult ? pdfResult.docId : null;
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        setTimeout(() => {
          this.dispatchEvent(new CustomEvent('close', { detail: { docId: pdfDocId } }));
        }, 4000);
        return;
      }

      let questions = [];
      try {
        if (ext === 'xlsx' || ext === 'xls') {
          // Use mapping UI data if available, otherwise fall back to auto-detect
          questions = this.sheetRenderData.length > 0
            ? this._parseExcelFromSheets()
            : this._parseExcel(arrayBuffer);
        } else if (ext === 'docx' && this.jsZipLoaded) {
          questions = await this._parseWord(arrayBuffer);
        }
      } catch (parseErr) {
        console.warn('File parsing skipped:', parseErr?.message);
      }

      // Chunk questions into 200-item groups so each Apex call stays well
      // under the Aura ~4 MB request-body limit (large RFP docs can have
      // thousands of questions that together would exceed the limit).
      const CHUNK = 200;
      const totalCount = questions.length;
      const firstChunk = questions.slice(0, CHUNK);

      // Step 1 — create document + insert first chunk (no file blob in this call)
      const result = await uploadAndParseQaDocument({
        fileName:           this.fileName,
        companyId:          this.companyId  || null,
        maId:               this.maId       || null,
        rfpId:              this.rfpId      || null,
        dueDate:            this.dueDate    || null,
        questionsJson:      JSON.stringify(firstChunk),
        totalQuestionCount: totalCount > 0 ? totalCount : null
      });
      if (this._uploadCancelled) return;
      const docId = result.docId;

      // Step 2 — insert remaining chunks sequentially
      for (let i = CHUNK; i < questions.length; i += CHUNK) {
        if (this._uploadCancelled) return;
        // eslint-disable-next-line no-await-in-loop
        await addQuestionsToDocument({
          documentId:    docId,
          questionsJson: JSON.stringify(questions.slice(i, i + CHUNK)),
          offset:        i
        });
      }

      // Step 3 — attach original file in a separate call (fire-and-forget)
      attachFileToDocument({
        documentId: docId,
        base64Data: base64,
        fileName:   this.fileName
      }).catch(err => console.warn('File attachment failed:', err?.body?.message || err?.message));

      // Step 4 — kick off answer matching
      const count = totalCount;
      if (count > 0) {
        startAnswerSearchBatch({ documentId: docId }).catch(err => {
          console.error('startAnswerSearchBatch failed:', err?.body?.message || err?.message);
        });
      }

      // Send question-processed email if the full upload took more than 2 seconds
      if (count > 0 && (Date.now() - uploadStartTime) > 2000) {
        notifyQuestionsProcessed({ documentId: docId }).catch(err => {
          console.warn('notifyQuestionsProcessed failed:', err?.body?.message || err?.message);
        });
      }

      this._uploadComplete = true;
      const toastMsg = count > 0
        ? `Document uploaded. ${count} question${count === 1 ? '' : 's'} extracted. Answer matching has started.`
        : 'Document uploaded. No questions were detected in this file.';
      this._showToast('Success', toastMsg, 'success');
      // eslint-disable-next-line @lwc/lwc/no-async-operation
      setTimeout(() => {
        this.dispatchEvent(new CustomEvent('close', { detail: { docId } }));
      }, 3500);
    } catch (error) {
      this.isUploading  = false;
      this.errorMessage = error.body ? error.body.message : 'Upload failed. Please try again.';
    }
  }

  // ── Excel sheet mapping handlers ────────────────────────────────────

  _prepareExcel(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const data     = new Uint8Array(e.target.result);
      const workbook = this.XLSX.read(data, { type: 'array' });
      this.sheetRenderData = workbook.SheetNames.map(name => ({
        name,
        rows:      this.XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: false, defval: '' }),
        headerRow: '',
        headers:   [],
        mapping:   { questionNo: '', questionText: '', section: '', answerLimit: '' },
        isSelected: false
      }));
      this.showExcelMapping = true;
    };
    reader.readAsArrayBuffer(file);
  }

  handleSheetToggle(event) {
    const name    = event.target.dataset.sheet;
    const checked = event.target.checked;
    this.sheetRenderData = this.sheetRenderData.map(s =>
      s.name === name ? { ...s, isSelected: checked } : s
    );
  }

  handleHeaderRowChange(event) {
    const sheetName = event.target.dataset.sheet;
    const rowStr    = event.detail.value;
    this.sheetRenderData = this.sheetRenderData.map(s => {
      if (s.name !== sheetName) return s;
      const rowIdx = rowStr ? parseInt(rowStr, 10) - 1 : 0;
      const rawRow = (s.rows[rowIdx] || []);
      const headers = [{ label: '(none)', value: '' }].concat(
        rawRow.map((col, idx) => {
          const letter = idx < 26
            ? String.fromCharCode(65 + idx)
            : String.fromCharCode(64 + Math.floor(idx / 26)) + String.fromCharCode(65 + (idx % 26));
          const label = col === null || String(col).trim() === '' ? `Col ${letter}` : String(col);
          return { label: `${letter}: ${label}`, value: String(idx) };
        })
      );
      // Auto-map by header label
      const auto = { questionNo: '', questionText: '', section: '', answerLimit: '' };
      headers.slice(1).forEach(h => {
        const t = h.label.toLowerCase();
        if (!auto.questionNo   && (t.includes('#q') || (t.includes('question') && (t.includes('no') || t.includes('#'))) || t === 'a: #q')) {
          auto.questionNo = h.value;
        } else if (!auto.questionText && t.includes('question')) {
          auto.questionText = h.value;
        } else if (!auto.section && (t.includes('section') || t.includes('rfi'))) {
          auto.section = h.value;
        } else if (!auto.answerLimit && (t.includes('limit') || t.includes('size'))) {
          auto.answerLimit = h.value;
        }
      });
      return { ...s, headerRow: rowStr, headers, mapping: auto };
    });
  }

  handleColMappingChange(event) {
    const sheetName = event.target.dataset.sheet;
    const field     = event.target.dataset.field;
    const value     = event.detail.value;
    this.sheetRenderData = this.sheetRenderData.map(s =>
      s.name === sheetName ? { ...s, mapping: { ...s.mapping, [field]: value } } : s
    );
  }

  _parseExcelFromSheets() {
    const questions = [];
    for (const sheet of this.sheetRenderData.filter(s => s.isSelected)) {
      const map      = sheet.mapping || {};
      const qCol     = map.questionText !== '' ? parseInt(map.questionText, 10) : -1;
      const secCol   = map.section      !== '' ? parseInt(map.section,      10) : -1;
      const noCol    = map.questionNo   !== '' ? parseInt(map.questionNo,   10) : -1;
      const limCol   = map.answerLimit  !== '' ? parseInt(map.answerLimit,  10) : -1;
      // Question text column is required; section column is optional (auto-detected when absent).
      if (qCol < 0) continue;
      const startRow = sheet.headerRow ? parseInt(sheet.headerRow, 10) : 1; // 1-based
      // Pre-scan: check if this sheet uses hierarchical numbering (e.g. "2.1", "2.1.1").
      // If 3-segment numbers exist alongside 2-segment ones, the 2-segment rows are section headers.
      const hasThreeSegmentNos = noCol >= 0 && sheet.rows.slice(startRow).some(r => {
        const n = ((r || [])[noCol] || '').toString().trim();
        return /^\d+\.\d+\.\d/.test(n);
      });
      // When no section column is mapped, sections are inferred from:
      //   (a) Rows where the Q# has exactly 2 dot-separated numeric segments and 3-segment
      //       rows also exist (e.g. "2.1" heading "Rating Questions") — hierarchical format.
      //   (b) Rows where the Q# column has non-numeric text and question text is blank.
      let autoSection = ''; // no default section — only set from detected section header rows
      for (let r = startRow; r < sheet.rows.length; r++) {
        const row     = sheet.rows[r] || [];
        const rawQ    = (row[qCol]   || '').toString().trim();
        const qText   = this._stripBullet(this._stripQuotes(rawQ));
        const qNo     = noCol >= 0 ? (row[noCol] || '').toString().trim() : '';
        // ── Auto-section detection (only when Section = "(none)") ──────────
        // Case (a): hierarchical "X.Y" row — section name is in the question text column.
        if (secCol < 0 && hasThreeSegmentNos && /^\d+\.\d+$/.test(qNo)) {
          autoSection = qText || qNo;
          continue;
        }
        // Case (b): non-numeric Q# with blank question text (e.g. "Medical Claims Administration").
        if (secCol < 0 && !qText && qNo && !/^\d/.test(qNo)) {
          const candidate = this._stripBullet(qNo).replace(/\s*-+\s*$/, '');
          if (candidate) autoSection = candidate;
          continue;
        }
        if (!qText) continue;
        // Skip rows whose Q# column contains a non-numeric label (column headers like
        // "Q." that slip through when Header Row is set one row too low).
        if (qNo && noCol >= 0 && !/^\d/.test(qNo)) continue;
        // ── Resolve section for this row ───────────────────────────────────
        if (secCol < 0) {
          // No section column — use auto-detected section.
          const section = autoSection;
          // Merge rows sharing the same Q# and section as sub-items.
          if (qNo && questions.length > 0) {
            const prev = questions[questions.length - 1];
            if (prev.no === qNo && prev.section === section) {
              prev.question += '\n' + qText;
              continue;
            }
          }
          questions.push({
            no:          qNo,
            section,
            question:    qText,
            answerLimit: limCol >= 0 ? (row[limCol] || '').toString().trim() : ''
          });
        } else {
          // Section column is mapped — read it and strip trailing " -" separators.
          const secRaw = this._stripBullet((row[secCol] || '').toString().trim())
                             .replace(/\s*-+\s*$/, '');
          // Update the running section tracker whenever a non-blank value appears.
          // When the cell is blank, inherit the last-seen value so rows in the same
          // section group are never silently dropped.
          if (secRaw) autoSection = secRaw;
          const section = autoSection;
          // Merge rows sharing the same Q# and section as continuation lines.
          if (qNo && questions.length > 0) {
            const prev = questions[questions.length - 1];
            if (prev.no === qNo && prev.section === section) {
              prev.question += '\n' + qText;
              continue;
            }
          }
          questions.push({
            no:          qNo,
            section,
            question:    qText,
            answerLimit: limCol >= 0 ? (row[limCol] || '').toString().trim() : ''
          });
        }
      }
    }
    return questions;
  }

  // ── File reading helpers ────────────────────────────────────────────

  _readAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  _readAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  }

  // ── Text-cleaning helpers ───────────────────────────────────────────

  // Strip surrounding double quotation marks (straight ", left-curly ", right-curly ").
  _stripQuotes(text) {
    return text.replace(/^[""]+|[""]+$/g, '').trim();
  }

  // Strip any leading non-letter, non-digit characters — catches ◆ ♦ • ► ▪ and any other bullet
  // regardless of which Unicode code point the document uses.
  _stripBullet(text) {
    return text.replace(/^[^\p{L}\p{N}"'(]+/u, '').trim();
  }

  // ── Excel parser (SheetJS) ──────────────────────────────────────────
  // Expects columns: A=No  B=Section  C=Question  D=Answer Size Limit
  // Row 0 is the header row and is skipped.

  _parseExcel(arrayBuffer) {
    const data     = new Uint8Array(arrayBuffer);
    const workbook = this.XLSX.read(data, { type: 'array' });
    const sheet    = workbook.Sheets[workbook.SheetNames[0]];
    const rows     = this.XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });

    // Scan the first 20 rows for the header row (must contain both a "question" column
    // and a "section" column). Detect all column positions from labels so we handle any
    // column order (#Q|Question|RFI Section  OR  No|Section|Question|Answer Size Limit).
    let headerRowIdx = 0;
    let colNo = 0, colQuestion = 1, colSection = 2, colLimit = -1;

    for (let i = 0; i < Math.min(rows.length, 20); i++) {
      const cells = rows[i].map(c => (c || '').toString().toLowerCase().trim());
      const qIdx   = cells.findIndex(c => c === 'question');
      const secIdx = cells.findIndex(c => c === 'section' || c === 'rfi section');
      if (qIdx !== -1 && secIdx !== -1) {
        headerRowIdx = i;
        const noIdx  = cells.findIndex(c => c === '#q' || c === 'no' || c === '#' || c === '#no');
        const limIdx = cells.findIndex(c => c.includes('answer') && (c.includes('limit') || c.includes('size')));
        if (noIdx  >= 0) colNo      = noIdx;
        colQuestion = qIdx;
        colSection  = secIdx;
        if (limIdx >= 0) colLimit   = limIdx;
        break;
      }
    }

    const questions = [];
    for (let i = headerRowIdx + 1; i < rows.length; i++) {
      const row     = rows[i];
      const qText   = this._stripBullet(this._stripQuotes((row[colQuestion] || '').toString().trim()));
      const section = this._stripBullet((row[colSection]  || '').toString().trim());
      if (!qText) continue;
      if (!section) {
        let inheritedSec = '';
        const subItems = [];
        let k = i + 1;
        while (k < rows.length) {
          const nr    = rows[k] || [];
          const nqRaw = (nr[colQuestion] || '').toString().trim();
          const nSec  = this._stripBullet((nr[colSection] || '').toString().trim());
          if (!nSec || !/^[^\p{L}\p{N}"'(]/u.test(nqRaw)) break;
          if (!inheritedSec) inheritedSec = nSec;
          else if (nSec !== inheritedSec) break;
          subItems.push(this._stripBullet(this._stripQuotes(nqRaw)));
          k++;
        }
        if (inheritedSec && subItems.length > 0) {
          questions.push({
            no:          (row[colNo]    || '').toString().trim(),
            section:     inheritedSec,
            question:    qText + '\n• ' + subItems.join('\n• '),
            answerLimit: colLimit >= 0 ? (row[colLimit] || '').toString().trim() : ''
          });
          i = k - 1;
        }
        continue;
      }
      questions.push({
        no:          (row[colNo] || '').toString().trim(),
        section:     section,
        question:    qText,
        answerLimit: colLimit >= 0 ? (row[colLimit] || '').toString().trim() : ''
      });
    }
    return questions;
  }

  // ── Word parser (JSZip + DOMParser) ────────────────────────────────
  // Supports:
  //   1) Table – first row is header (No | Section | Question | Answer Size Limit)
  //   2) Numbered paragraphs – each non-empty paragraph becomes a question

  // Yield helper — hands control back to the browser event loop so the page
  // stays responsive during long synchronous operations.
  _yield() { return new Promise(r => setTimeout(r, 0)); }

  async _parseWord(arrayBuffer) {
    const zip     = await window.JSZip.loadAsync(arrayBuffer);
    const xmlText = await zip.file('word/document.xml').async('string');
    if (xmlText.length > 5_000_000) throw new Error('Document is too large to process (5 MB XML limit).');

    // DOMParser is synchronous; yield first so the browser can paint any
    // pending UI updates (e.g. "Uploading…" button state) before we block.
    await this._yield();
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    const questions = [];

    // Use the table parser only when the FIRST table looks like a question table
    // (header row has a "Question" or "q" column). Documents that merely contain
    // data/statistics tables (like RFP metrics grids) must NOT use this path.
    const tables = doc.getElementsByTagName('w:tbl');
    const firstTableHeaderCells = tables.length > 0
      ? Array.from((tables[0].getElementsByTagName('w:tr')[0] || { getElementsByTagName: () => [] })
          .getElementsByTagName('w:tc'))
          .map(tc => Array.from(tc.getElementsByTagName('w:t')).map(t => t.textContent || '').join(' ').trim().toLowerCase())
      : [];
    const isQuestionTable = firstTableHeaderCells.length >= 2 &&
      firstTableHeaderCells.some(c => c.includes('question') || c === 'q' || c === '#q');

    if (isQuestionTable) {
      const rows = Array.from(tables[0].getElementsByTagName('w:tr'));
      let isHeader = true;
      for (const row of rows) {
        if (isHeader) { isHeader = false; continue; }
        const cells = Array.from(row.getElementsByTagName('w:tc')).map(tc =>
          Array.from(tc.getElementsByTagName('w:t')).map(t => t.textContent || '').join(' ').trim()
        );
        if (cells.length < 3 || !cells[2].trim()) continue;
        questions.push({
          no:          cells[0] || '',
          section:     this._stripBullet(cells[1] || ''),
          question:    this._stripBullet(this._stripQuotes(cells[2])),
          answerLimit: cells[3] || ''
        });
      }
    } else {
      // Numbered paragraph format with section tracking.
      //
      // Three numbering styles handled:
      //   A) Manually typed:      "1. Question text" — number is in <w:t>
      //   B) Word decimal list:   <w:numPr> where numFmt is decimal/letter/roman
      //   C) Word bullet list:    <w:numPr> where numFmt is bullet — used for section headers
      //
      // word/numbering.xml is parsed first so we can tell B from C regardless
      // of which ilvl the questions sit at (multi-level lists use ilvl>0 for questions).

      // Build map: "numId_ilvl" → true when that combination is a decimal-style list
      const decimalKeys   = new Set();
      const letterKeys    = new Set(); // lowerLetter / upperLetter sub-items (a., b., c.)
      const unknownNumIds = new Set(); // numIds with no resolvable level format (w:numStyleLink)
      const DECIMAL_FMTS  = new Set(['decimal','decimalZero','lowerRoman','upperRoman']);
      const LETTER_FMTS   = new Set(['lowerLetter','upperLetter']);
      try {
        const numFile = zip.file('word/numbering.xml');
        if (numFile) {
          const numXml  = await numFile.async('string');
          const numDoc  = new DOMParser().parseFromString(numXml, 'application/xml');

          // abstractNum: id → { ilvl → numFmt }
          const abstractFmts = {};
          for (const an of Array.from(numDoc.getElementsByTagName('w:abstractNum'))) {
            const aid = an.getAttribute('w:abstractNumId');
            abstractFmts[aid] = {};
            for (const lvl of Array.from(an.getElementsByTagName('w:lvl'))) {
              const il = lvl.getAttribute('w:ilvl');
              const nf = lvl.getElementsByTagName('w:numFmt')[0];
              abstractFmts[aid][il] = nf ? nf.getAttribute('w:val') : 'bullet';
            }
          }

          // num: numId → abstractNumId → fill decimalKeys / letterKeys / unknownNumIds
          // unknownNumIds: numIds whose abstract has no level formats (w:numStyleLink pattern).
          // Word docs that link to a named list style rather than defining levels inline
          // produce empty abstractFmts entries. We default those to decimal at ilvl=0.
          for (const num of Array.from(numDoc.getElementsByTagName('w:num'))) {
            const nid   = num.getAttribute('w:numId');
            const aref  = num.getElementsByTagName('w:abstractNumId')[0];
            const aid   = aref ? aref.getAttribute('w:val') : null;
            if (!aid || !abstractFmts[aid]) { unknownNumIds.add(nid); continue; }
            const fmts = abstractFmts[aid];
            if (Object.keys(fmts).length === 0) { unknownNumIds.add(nid); continue; }
            for (const [il, fmt] of Object.entries(fmts)) {
              if (DECIMAL_FMTS.has(fmt)) decimalKeys.add(`${nid}_${il}`);
              if (LETTER_FMTS.has(fmt))  letterKeys.add(`${nid}_${il}`);
            }
          }
        }
      } catch(e) { /* numbering.xml unavailable — fall back to ilvl=0 heuristic */ }

      let currentSection = '';
      let sectionLocalQNo = 0; // per-section counter for auto-numbered (decimal list) questions
      let questionSeenInSection = false;
      // Tracks consecutive plain-bold section candidates seen without a numbered question
      // between them. If two appear in a row (e.g. "Customer Service Center" then
      // "Claims Processing Center" as answer-template labels), both are reverted so the
      // enclosing section stays unchanged.
      let lastParaWasSectionCandidate = false;
      let sectionBeforeCandidate = '';
      let sectionLocalQNoBeforeCandidate = 0;
      let questionSeenBeforeCandidate = false;
      let paraCount = 0;

      for (const para of Array.from(doc.getElementsByTagName('w:p'))) {
        // Yield every 100 paragraphs so the browser stays responsive on large docs.
        if (++paraCount % 100 === 0) await this._yield();
        // Include <w:tab/> as a space and <w:noBreakHyphen/> as a regular hyphen
        // so compound words like "Carve-Outs" are preserved in the output.
        const text = Array.from(para.getElementsByTagName('w:r')).flatMap(r =>
          Array.from(r.childNodes).map(n =>
            n.localName === 't'             ? (n.textContent || '') :
            n.localName === 'tab'           ? ' '                   :
            n.localName === 'noBreakHyphen' ? '-'                   : ''
          )
        ).join('').trim();
        if (!text) continue;

        // Detect paragraphs inside table cells (w:tc) - bold column headers in
        // statistics tables must not be treated as section headers.
        const isInTableCell = (() => {
          let el = para.parentNode;
          while (el) {
            if (el.localName === 'tc' || el.tagName === 'w:tc') return true;
            if (el.localName === 'body' || el.tagName === 'w:body') break;
            el = el.parentNode;
          }
          return false;
        })();

        const pPr = para.getElementsByTagName('w:pPr')[0];

        // ── Heading style ────────────────────────────────────────────────
        const pStyle  = pPr ? pPr.getElementsByTagName('w:pStyle')[0] : null;
        const styleId = pStyle ? (pStyle.getAttribute('w:val') || '') : '';
        const isHeading = /^heading/i.test(styleId);

        // ── Auto-numbering (<w:numPr>) ───────────────────────────────────
        const numPr   = pPr ? pPr.getElementsByTagName('w:numPr')[0] : null;
        const numIdEl = numPr ? numPr.getElementsByTagName('w:numId')[0] : null;
        const numId   = numIdEl ? numIdEl.getAttribute('w:val') : '0';
        const ilvlEl  = numPr ? numPr.getElementsByTagName('w:ilvl')[0] : null;
        const ilvl    = ilvlEl ? parseInt(ilvlEl.getAttribute('w:val') || '0', 10) : -1;
        const fmtKey  = `${numId}_${ilvl}`;

        // isDecimalList: true for question-numbered lists; false for bullet/letter sub-item lists
        const isDecimalList = numId !== '0' && ilvl >= 0 && (
          decimalKeys.has(fmtKey) ||                       // explicitly decimal
          (unknownNumIds.has(numId) && ilvl === 0) ||      // unknown format (numStyleLink) at top level
          (decimalKeys.size === 0 && ilvl === 0)           // no numbering.xml at all — ilvl=0 heuristic
        );

        // isLetterSubItem: a., b., c. list — append to parent question, not a new question
        const isLetterSubItem = numId !== '0' && ilvl >= 0 && letterKeys.has(fmtKey);

        // ── All-bold paragraph (section title without Heading style) ─────
        const textRuns = Array.from(para.getElementsByTagName('w:r')).filter(r => {
          const t = r.getElementsByTagName('w:t')[0];
          return t && t.textContent.trim();
        });
        const isBold = textRuns.length > 0 && textRuns.every(r => {
          const rPr = r.getElementsByTagName('w:rPr')[0];
          return rPr && rPr.getElementsByTagName('w:b').length > 0;
        });

        // Bullet list item (◆ sections etc.) — numId present but NOT a decimal or letter list
        const isBulletListItem = numId !== '0' && !isDecimalList && !isLetterSubItem;

        // Roman-numeral section header (I., II., III., IV., V. ...) — these always signal
        // a new section regardless of bold/heading style and override the questionSeenInSection guard.
        const isRomanSectionHeader = /^[IVX]{1,5}\.\s+[A-Z]/.test(text);

        // ── Case A0: compound sub-question number ("1a. text", "1b) text", "2c text") ──
        // Creates a separate question record; Apex converts "1a" → Q# 1.1 for ordering.
        const compoundMatch = !isInTableCell && text.match(/^[\(]?(\d+)([a-zA-Z])[\)\.]\s*(.+)/);

        // ── Case A: manually typed number prefix ("1. text" or "1.text") ──
        const match = !compoundMatch && !isInTableCell && text.match(/^[\(]?(\d+)[\)\.]\s*(.+)/);

        if (compoundMatch) {
          questionSeenInSection = true;
          lastParaWasSectionCandidate = false;
          questions.push({
            no:          compoundMatch[1] + compoundMatch[2],
            section:     currentSection,
            question:    this._stripBullet(this._stripQuotes(compoundMatch[3].trim())),
            answerLimit: ''
          });
        } else if (match) {
          questionSeenInSection = true;
          lastParaWasSectionCandidate = false;
          questions.push({
            no:          match[1],
            section:     currentSection,
            question:    this._stripBullet(this._stripQuotes(match[2].trim())),
            answerLimit: ''
          });
        } else if (isDecimalList && !isInTableCell) {
          // ── Case B: decimal-numbered Word list → use per-section counter ───
          questionSeenInSection = true;
          lastParaWasSectionCandidate = false;
          questions.push({
            no:          String(++sectionLocalQNo),
            section:     currentSection,
            question:    this._stripBullet(this._stripQuotes(text)),
            answerLimit: ''
          });
        } else if (isHeading || isRomanSectionHeader) {
          // ── Strong section header: Heading style or Roman numeral (I., II., ...) ─
          // Purely numeric/symbolic text (e.g. table column headers "2024", "2025")
          // is not a real section header even when styled as a heading.
          // Metric row labels (e.g. "Percentage of outbound calls that are recorded")
          // are never real sections even when the Word author applied a Heading style.
          const headingText = this._stripBullet(text);
          if (headingText.length > 0 && /[a-zA-Z]/.test(headingText)) {
            const isMetricHeading = /^(percentage|average|number\s+of|rate\s+of|ratio\s+of|call\s+abandonment|first\s+call\s+resolution|overpayment|claim\s+(?:payment|processing)|length\s+of\s+hold)/i.test(headingText);
            if (!isMetricHeading) {
              currentSection = headingText;
              questionSeenInSection = false;
              sectionLocalQNo = 0;
              lastParaWasSectionCandidate = false;
            }
          }
        } else if (isLetterSubItem && questions.length > 0) {
          // ── Case C: letter list sub-item (a., b.) via Word numbering → append to parent
          questions[questions.length - 1].question += '\n  ' + text;
        } else if (/^[a-z][\)\.]\s+/.test(text) && questionSeenInSection && questions.length > 0) {
          // ── Case D: manually typed lowercase letter sub-question (a. HQ location)
          questions[questions.length - 1].question += '\n  ' + text;
        } else if (isBold && (isBulletListItem || /^[^\p{L}\p{N}\s"'(]/u.test(text))) {
          // ── Bold + bullet-style = section header, always (even after questions).
          // Exception: metric row labels (e.g. "Percentage of outbound calls that are
          // recorded") formatted as list items in statistics tables are never sections.
          const boldBulletText = this._stripBullet(text);
          if (boldBulletText.length > 0 && /[a-zA-Z]/.test(boldBulletText)) {
            const isMetricBullet = /^(percentage|average|number\s+of|rate\s+of|ratio\s+of|call\s+abandonment|first\s+call\s+resolution|overpayment|claim\s+(?:payment|processing)|length\s+of\s+hold)/i.test(boldBulletText);
            if (!isMetricBullet) {
              currentSection = boldBulletText;
              questionSeenInSection = false;
              sectionLocalQNo = 0;
              lastParaWasSectionCandidate = false;
            }
          }
        } else if (isBold && !isInTableCell) {
          // ── Plain bold paragraph (not in a table cell).
          // ALL CAPS after questions = answer-template label ("CLAIM PROCESSING IN INDIA") → skip.
          // Otherwise treat as section header, but apply a paired-label guard:
          // if two consecutive plain-bold section candidates appear without a numbered
          // question between them (e.g. "Customer Service Center" then "Claims Processing
          // Center" as answer slots), revert both so the enclosing section is preserved.
          const isAllCaps = text.length > 0 && text === text.toUpperCase() && /[A-Z]/.test(text);
          if (!questionSeenInSection || !isAllCaps) {
            const stripped = this._stripBullet(text);
            // Purely numeric/symbolic bold text (e.g. "2024", "2025", "%") is never a
            // section header — only text containing at least one letter qualifies.
            if (stripped.length > 0 && /[a-zA-Z]/.test(stripped)) {
              // Measurement-metric row labels in statistics tables (e.g. "Percentage of
              // outbound calls that are recorded", "Average turnaround time", "Call
              // abandonment rate (%)") sometimes appear as bold paragraphs that are not
              // inside a <w:tc> in the Word XML. They are never real section headers.
              const isMetricRowLabel = /^(percentage|average|number\s+of|rate\s+of|ratio\s+of|call\s+abandonment|first\s+call\s+resolution|overpayment|claim\s+(?:payment|processing)|length\s+of\s+hold)/i.test(stripped);
              if (isMetricRowLabel) {
                // Revert any pending candidate — a metric label never confirms a prior one.
                if (lastParaWasSectionCandidate) {
                  currentSection = sectionBeforeCandidate;
                  sectionLocalQNo = sectionLocalQNoBeforeCandidate;
                  questionSeenInSection = questionSeenBeforeCandidate;
                }
                lastParaWasSectionCandidate = false;
              } else if (lastParaWasSectionCandidate) {
                // Revert: restore everything saved before the first candidate.
                currentSection = sectionBeforeCandidate;
                sectionLocalQNo = sectionLocalQNoBeforeCandidate;
                questionSeenInSection = questionSeenBeforeCandidate;
                if (questionSeenBeforeCandidate) {
                  // Questions were seen before this run of bold paragraphs, so they
                  // are likely answer-template labels (stats rows, table headers) rather
                  // than real section headers. Stay on alert: save the just-reverted
                  // state so the NEXT bold paragraph also reverts if no question appears
                  // between them. This handles runs of any length, not just even pairs.
                  sectionBeforeCandidate = currentSection;
                  sectionLocalQNoBeforeCandidate = sectionLocalQNo;
                  lastParaWasSectionCandidate = true;
                } else {
                  lastParaWasSectionCandidate = false;
                }
              } else {
                sectionBeforeCandidate = currentSection;
                sectionLocalQNoBeforeCandidate = sectionLocalQNo;
                questionSeenBeforeCandidate = questionSeenInSection;
                currentSection = stripped;
                questionSeenInSection = false;
                sectionLocalQNo = 0;
                lastParaWasSectionCandidate = true;
              }
            }
          } else {
            lastParaWasSectionCandidate = false;
          }
        } else if (isBulletListItem && !questionSeenInSection) {
          // ── Non-bold bullet list item before any question = section header.
          const bulletText = this._stripBullet(text);
          if (/[a-zA-Z]/.test(bulletText)) {
            currentSection = bulletText;
            sectionLocalQNo = 0;
            lastParaWasSectionCandidate = false;
          }
        } else if (isBulletListItem && questionSeenInSection && questions.length > 0 && !isInTableCell) {
          // ── Bullet sub-item after a question (e.g. "• Which diseases do you target...")
          // Append to the immediately preceding question so sub-questions are preserved.
          questions[questions.length - 1].question += '\n  ' + this._stripBullet(text);
        } else if (isBold && isInTableCell && questions.length > 0) {
          // ── Bold row-label inside a table cell (e.g. "Claim payment accuracy...")
          // Append as a sub-item of the immediately preceding question so the
          // answer slots captured in the table are visible in the Q&A record.
          questions[questions.length - 1].question += '\n  ' + text;
        }
        // Everything else (title, prose, non-bold table content) is silently ignored
      }
    }
    return questions;
  }
}