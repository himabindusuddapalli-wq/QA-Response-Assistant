/**
 * @description Single controller behind the Q&A Response download feature.
 *              Supports multi-category downloads (comma-separated category param).
 *              Best-match pulls the top repository match for each unanswered question.
 */
public with sharing class QnaDownloadController {

    // ===================== LWC (popup stats) =====================

    public class Stats {
        @AuraEnabled public String  documentName;
        @AuraEnabled public String  rfpName;
        @AuraEnabled public String  fileName;
        @AuraEnabled public Integer total     = 0;
        @AuraEnabled public Integer finalized = 0;
        @AuraEnabled public Integer pending   = 0;
    }

    @AuraEnabled(cacheable=true)
    public static Stats getStats(Id documentId) {
        Stats s = new Stats();
        if (documentId == null) return s;

        List<Q_A_Document__c> docs = [
            SELECT Name, RFP__r.Name,
                   Total_Questions__c, Finalized_Questions__c, Pending_Questions__c
            FROM Q_A_Document__c
            WHERE Id = :documentId
            WITH USER_MODE
            LIMIT 1
        ];
        if (docs.isEmpty()) return s;

        Q_A_Document__c d = docs[0];
        s.documentName = d.Name;
        s.rfpName      = (d.RFP__r != null) ? d.RFP__r.Name : '';
        s.total        = (d.Total_Questions__c     != null) ? d.Total_Questions__c.intValue()     : 0;
        s.finalized    = (d.Finalized_Questions__c != null) ? d.Finalized_Questions__c.intValue() : 0;
        s.pending      = (d.Pending_Questions__c   != null) ? d.Pending_Questions__c.intValue()   : 0;

        // newest attached file's Title, for the modal subtitle
        List<ContentDocumentLink> links = [
            SELECT ContentDocument.Title
            FROM ContentDocumentLink
            WHERE LinkedEntityId = :documentId
            WITH USER_MODE
            ORDER BY SystemModstamp DESC
            LIMIT 1
        ];
        s.fileName = links.isEmpty() ? '' : links[0].ContentDocument.Title;

        return s;
    }

    // ===================== VF page (Word / Excel download) =====================

    public String  docName        { get; private set; }
    public String  rfpName        { get; private set; }
    public String  company        { get; private set; }
    public String  maName         { get; private set; }
    public String  category       { get; private set; }
    public String  docUrl         { get; private set; }   // Q&A Document record page
    public String  fileTitle      { get; private set; }   // related file's Title
    public List<Row> rows         { get; private set; }
    public List<SectionGroup> sectionGroups { get; private set; }

    // ---- export metadata (cover summary) ----
    public String  generatedBy    { get; private set; }
    public String  generatedOn    { get; private set; }   // full timestamp
    public String  generatedDate  { get; private set; }   // date only
    public Integer totalQuestions { get; private set; }
    public Integer finalized      { get; private set; }

    private String fileType;
    private Set<String> cats;   // parsed category set

    public class Row implements Comparable {
        public String qNo      { get; set; }
        public String section  { get; set; }
        public String question { get; set; }
        public String answer   { get; set; }

        // Returns the answer with dangerous HTML stripped, safe for escape="false" rendering.
        public String getSafeAnswer() {
            return sanitizeHtml(answer);
        }

        public Integer compareTo(Object other) {
            Row r = (Row) other;
            List<String> segsA = (this.qNo != null ? this.qNo : '').split('\\.');
            List<String> segsB = (r.qNo    != null ? r.qNo    : '').split('\\.');
            Integer minLen = Math.min(segsA.size(), segsB.size());
            for (Integer i = 0; i < minLen; i++) {
                Integer numA = 0;
                Integer numB = 0;
                try { numA = Integer.valueOf(segsA[i].trim()); } catch (Exception ex) {}
                try { numB = Integer.valueOf(segsB[i].trim()); } catch (Exception ex) {}
                if (numA != numB) return numA - numB;
            }
            return segsA.size() - segsB.size();
        }
    }

    // One heading + its questions, so the section name renders once.
    public class SectionGroup {
        public String     section { get; set; }
        public List<Row>  rows    { get; set; }
        public SectionGroup(String s) {
            section = s;
            rows    = new List<Row>();
        }
    }

    public QnaDownloadController() {
        rows           = new List<Row>();
        sectionGroups  = new List<SectionGroup>();
        generatedBy    = UserInfo.getName();
        generatedOn    = System.now().format('MMM d, yyyy, h:mm a', UserInfo.getTimeZone().getID());
        generatedDate  = System.now().format('MMMM d, yyyy', UserInfo.getTimeZone().getID());
        totalQuestions = 0;
        finalized      = 0;

        Map<String, String> p = ApexPages.currentPage().getParameters();
        String idParam = p.get('id');
        category = String.isBlank(p.get('category')) ? 'all' : p.get('category');
        if (String.isNotBlank(idParam)) {
            loadRows((Id) idParam);
        }
    }

    private void loadRows(Id docId) {
        List<Q_A_Document__c> docs = [
            SELECT Name, File_Type__c, Total_Questions__c, Finalized_Questions__c,
                   RFP__r.Name, Company__r.Name, Membership_Activity__r.Name
            FROM Q_A_Document__c
            WHERE Id = :docId
            WITH USER_MODE
            LIMIT 1
        ];
        if (docs.isEmpty()) { fileType = 'word'; return; }

        Q_A_Document__c d = docs[0];
        docName        = d.Name;
        docUrl         = URL.getOrgDomainUrl().toExternalForm() + '/lightning/r/Q_A_Document__c/' + docId + '/view';
        rfpName        = (d.RFP__r != null)                 ? d.RFP__r.Name : '';
        company        = (d.Company__r != null)             ? d.Company__r.Name : '';
        maName         = (d.Membership_Activity__r != null) ? d.Membership_Activity__r.Name : '';
        fileType       = (d.File_Type__c != null) ? d.File_Type__c.toLowerCase() : 'word';
        totalQuestions = (d.Total_Questions__c     != null) ? d.Total_Questions__c.intValue()     : 0;
        finalized      = (d.Finalized_Questions__c != null) ? d.Finalized_Questions__c.intValue() : 0;

        loadFileInfo(docId);

        // parse comma-separated category param into a normalized set
        cats = new Set<String>();
        for (String c : category.split(',')) {
            String t = (c == null) ? '' : c.trim().toLowerCase();
            if (String.isNotBlank(t)) cats.add(t);
        }
        if (cats.isEmpty()) cats.add('all');

        if (cats.contains('custom')) {
            loadCustomRows(docId);
        } else if (cats.contains('bestmatch')) {
            loadBestMatchRows(docId);
        } else {
            for (String c : cats) loadStandardRowsFor(docId, c);
            dedupeRows();
        }

        buildSectionGroups();
    }

    // Latest file attached to the Q&A Document (Files/ContentDocumentLink)
    private void loadFileInfo(Id docId) {
        List<ContentDocumentLink> links = [
            SELECT ContentDocument.Title
            FROM ContentDocumentLink
            WHERE LinkedEntityId = :docId
            WITH USER_MODE
            ORDER BY SystemModstamp DESC
            LIMIT 1
        ];
        fileTitle = links.isEmpty() ? null : links[0].ContentDocument.Title;
    }

    // ---- all / strategic / strategicdraft / draft / unanswered : SOQL filter (one category) ----
    private void loadStandardRowsFor(Id docId, String cat) {
        // strategic finalized: Completed + strategy applied
        if (cat == 'strategic') {
            for (Q_A_Question__c q : [
                SELECT QAQuestionNo__c, Section__c, QAQuestion__c, Final_Answer__c
                FROM Q_A_Question__c
                WHERE Q_A_Document__c = :docId
                  AND Status__c = 'Completed'
                  AND Strategy_Applied__c = true
                WITH USER_MODE
                ORDER BY Id ASC
            ]) {
                addRow(q.QAQuestionNo__c, q.Section__c, q.QAQuestion__c, q.Final_Answer__c);
            }
            return;
        }

        // strategic draft: Draft + strategy applied
        if (cat == 'strategicdraft') {
            for (Q_A_Question__c q : [
                SELECT QAQuestionNo__c, Section__c, QAQuestion__c, Final_Answer__c
                FROM Q_A_Question__c
                WHERE Q_A_Document__c = :docId
                  AND Status__c = 'Draft'
                  AND Strategy_Applied__c = true
                WITH USER_MODE
                ORDER BY Id ASC
            ]) {
                addRow(q.QAQuestionNo__c, q.Section__c, q.QAQuestion__c, q.Final_Answer__c);
            }
            return;
        }

        // all -> Completed, draft -> Draft, unanswered -> New
        String statusFilter =
              (cat == 'draft')      ? 'Draft'
            : (cat == 'unanswered') ? 'New'
            : 'Completed';

        for (Q_A_Question__c q : [
            SELECT QAQuestionNo__c, Section__c, QAQuestion__c, Final_Answer__c
            FROM Q_A_Question__c
            WHERE Q_A_Document__c = :docId
              AND Status__c = :statusFilter
            WITH USER_MODE
            ORDER BY Id ASC
        ]) {
            addRow(q.QAQuestionNo__c, q.Section__c, q.QAQuestion__c, q.Final_Answer__c);
        }
    }

    // ---- best match : each New question + its top repository match answer ----
    // Mirrors the review panel: the first match is the highest Match_Score__c,
    // tie-broken by having a consulting firm, then most recent effective period.
    private void loadBestMatchRows(Id docId) {
        List<Q_A_Question__c> qs = [
            SELECT Id, QAQuestionNo__c, Section__c, QAQuestion__c
            FROM Q_A_Question__c
            WHERE Q_A_Document__c = :docId
              AND Status__c = 'New'
            WITH USER_MODE
            ORDER BY Id ASC
        ];
        if (qs.isEmpty()) return;

        Set<Id> qIds = new Set<Id>();
        for (Q_A_Question__c q : qs) qIds.add(q.Id);

        // ordered so the best match is the first row seen per question
        Map<Id, Q_A_Answer__c> topByQ = new Map<Id, Q_A_Answer__c>();
        for (Q_A_Answer__c a : [
                SELECT Q_A_Question__c, Answer__c, Match_Score__c,
                       Consulting_Firm__c, Effective_Period__c
                FROM Q_A_Answer__c
                WHERE Q_A_Question__c IN :qIds
                WITH USER_MODE
                ORDER BY Match_Score__c DESC NULLS LAST,
                         Consulting_Firm__c DESC NULLS LAST,
                         Effective_Period__c DESC NULLS LAST
                ]) {
            if (!topByQ.containsKey(a.Q_A_Question__c)) {
                topByQ.put(a.Q_A_Question__c, a);   // first = top match
            }
        }

        for (Q_A_Question__c q : qs) {
            Q_A_Answer__c top = topByQ.get(q.Id);
            if (top == null) continue;   // no match -> skip, same as the review panel
            addRow(q.QAQuestionNo__c, q.Section__c, q.QAQuestion__c, top.Answer__c);
        }
    }

    // With multiple categories, a question can qualify twice (e.g. finalized + strategic).
    // Keep the first occurrence, keyed by question number (falls back to text).
    private void dedupeRows() {
        Set<String> seen = new Set<String>();
        List<Row> out = new List<Row>();
        for (Row r : rows) {
            String k = String.isNotBlank(r.qNo) ? r.qNo : String.valueOf(r.question);
            if (seen.contains(k)) continue;
            seen.add(k);
            out.add(r);
        }
        rows = out;
    }

    // ---- custom : include if selected-answer differs from final, OR IsStyled, OR Further edited ----
    private void loadCustomRows(Id docId) {
        List<Q_A_Question__c> qs = [
            SELECT QAQuestionNo__c, Section__c, QAQuestion__c, Final_Answer__c,
                   IsStyled__c, Further_edited__c
            FROM Q_A_Question__c
            WHERE Q_A_Document__c = :docId
              AND Status__c = 'Completed'
            WITH USER_MODE
            ORDER BY Id ASC
        ];
        if (qs.isEmpty()) return;

        Set<Id> qIds = new Set<Id>();
        for (Q_A_Question__c q : qs) qIds.add(q.Id);

        Map<Id, String> selectedAnsByQ = new Map<Id, String>();
        for (Q_A_Answer__c a : [
                SELECT Q_A_Question__c, Answer__c
                FROM Q_A_Answer__c
                WHERE Q_A_Question__c IN :qIds
                  AND Is_Selected_Answer__c = true
                WITH USER_MODE
                ]) {
            if (!selectedAnsByQ.containsKey(a.Q_A_Question__c)) {
                selectedAnsByQ.put(a.Q_A_Question__c, a.Answer__c);
            }
        }

        for (Q_A_Question__c q : qs) {
            Boolean isCustom = selectedAnsByQ.containsKey(q.Id)
                && (norm(selectedAnsByQ.get(q.Id)) != norm(q.Final_Answer__c));

            if (isCustom || q.IsStyled__c == true || q.Further_edited__c == true) {
                addRow(q.QAQuestionNo__c, q.Section__c, q.QAQuestion__c, q.Final_Answer__c);
            }
        }
    }

    private void addRow(String qNo, String section, String question, String answer) {
        Row r      = new Row();
        r.qNo      = qNo;
        r.section  = section;
        r.question = question;
        r.answer   = answer;
        rows.add(r);
    }

    // Collapse rows into section groups so each heading prints once.
    private void buildSectionGroups() {
        sectionGroups = new List<SectionGroup>();
        Map<String, SectionGroup> byName = new Map<String, SectionGroup>();
        for (Row r : rows) {
            String key = String.isBlank(r.section) ? '' : r.section;
            SectionGroup g = byName.get(key);
            if (g == null) {
                g = new SectionGroup(r.section);
                byName.put(key, g);
                sectionGroups.add(g);
            }
            g.rows.add(r);
        }
    }

    private static String norm(String s) {
        if (String.isBlank(s)) return '';
        return s.replaceAll('<[^>]+>', ' ')
                .replaceAll('&[a-zA-Z0-9#]+;', ' ')
                .replaceAll('\\s+', ' ')
                .trim();
    }

    // ---- category helpers ----
    private Boolean isMulti() { return cats != null && cats.size() > 1; }
    private String singleCat() {
        if (cats == null || cats.isEmpty()) return 'all';
        for (String c : cats) return c;
        return 'all';
    }

    public Boolean getIsExcel() {
        if (fileType == null) return false;
        return fileType.contains('exc') || fileType.contains('xls');
    }
    public Boolean getIsWord() { return !getIsExcel(); }

    // Chains Company — RFP — MA, skipping any that are blank.
    public String getCoverSubtitle() {
        List<String> parts = new List<String>();
        if (String.isNotBlank(company)) parts.add(company);
        if (String.isNotBlank(rfpName)) parts.add(rfpName);
        if (String.isNotBlank(maName))  parts.add(maName);
        return String.join(parts, '  \u2014  ');
    }

    // Human label for what's being downloaded, based on category.
    public String getExportTypeLabel() {
        if (isMulti()) return 'SELECTED RESPONSES';
        String c = singleCat();
        if (c == 'strategic')      return 'STRATEGIC RESPONSES';
        if (c == 'strategicdraft') return 'STRATEGIC DRAFT RESPONSES';
        if (c == 'draft')          return 'DRAFTED RESPONSES';
        if (c == 'unanswered')     return 'UNANSWERED QUESTIONS';
        if (c == 'bestmatch')      return 'BEST-MATCH RESPONSES';
        if (c == 'custom')         return 'CUSTOM EDITED RESPONSES';
        return 'FINALIZED RESPONSES';
    }

    public String getContentType() {
        return getIsExcel()
            ? 'application/vnd.ms-excel#' + fileBase() + '.xls'
            : 'application/msword#'       + fileBase() + '.doc';
    }

    // Base filename = related file's Title (extension stripped), else doc Name.
    private String fileBase() {
        String base = String.isNotBlank(fileTitle) ? stripExt(fileTitle)
                    : String.isNotBlank(docName)   ? docName
                    : 'export';
        return sanitize(base);
    }

    private static String stripExt(String s) {
        if (String.isBlank(s)) return s;
        Integer dot = s.lastIndexOf('.');
        return (dot > 0) ? s.substring(0, dot) : s;
    }

    private static String sanitize(String s) {
        if (String.isBlank(s)) return 'export';
        // drop chars that break the contentType "#filename" hack; keep spaces
        return s.replaceAll('[^A-Za-z0-9 _\\-]', '').trim();
    }

    @AuraEnabled
    public static void stampCustomEdits(Id documentId) {
        if (documentId == null) return;

        List<Q_A_Question__c> qs = [
            SELECT Final_Answer__c, Custom_Edit__c
            FROM Q_A_Question__c
            WHERE Q_A_Document__c = :documentId
              AND Status__c = 'Completed'
            WITH USER_MODE
        ];
        if (qs.isEmpty()) return;

        Set<Id> qIds = new Set<Id>();
        for (Q_A_Question__c q : qs) qIds.add(q.Id);

        Map<Id, String> selectedAnsByQ = new Map<Id, String>();
        for (Q_A_Answer__c a : [
                SELECT Q_A_Question__c, Answer__c
                FROM Q_A_Answer__c
                WHERE Q_A_Question__c IN :qIds
                  AND Is_Selected_Answer__c = true
                WITH USER_MODE
                ]) {
            if (!selectedAnsByQ.containsKey(a.Q_A_Question__c)) {
                selectedAnsByQ.put(a.Q_A_Question__c, a.Answer__c);
            }
        }

        List<Q_A_Question__c> toUpdate = new List<Q_A_Question__c>();
        for (Q_A_Question__c q : qs) {
            Boolean isCustom = selectedAnsByQ.containsKey(q.Id)
                && (norm(selectedAnsByQ.get(q.Id)) != norm(q.Final_Answer__c));
            if (q.Custom_Edit__c != isCustom) {
                q.Custom_Edit__c = isCustom;
                toUpdate.add(q);
            }
        }
        if (!toUpdate.isEmpty()) update toUpdate;
    }

    @AuraEnabled(cacheable=true)
    public static Map<String, Integer> getStrategicInfo(Id documentId) {
        Map<String, Integer> m = new Map<String, Integer>{
            'total' => 0, 'completed' => 0, 'strategic' => 0, 'strategicDraft' => 0
        };
        if (documentId == null) return m;

        for (Q_A_Question__c q : [
                SELECT Status__c, Strategy_Applied__c
                FROM Q_A_Question__c
                WHERE Q_A_Document__c = :documentId
                WITH USER_MODE
                ]) {
            m.put('total', m.get('total') + 1);
            Boolean completed = (q.Status__c == 'Completed');
            Boolean draft     = (q.Status__c == 'Draft');
            Boolean strat     = (q.Strategy_Applied__c == true);
            if (completed) m.put('completed', m.get('completed') + 1);
            if (completed && strat) m.put('strategic', m.get('strategic') + 1);
            if (draft && strat)     m.put('strategicDraft', m.get('strategicDraft') + 1);
        }
        return m;
    }

    @AuraEnabled(cacheable=true)
    public static Integer getCustomCount(Id documentId) {
        if (documentId == null) return 0;

        List<Q_A_Question__c> qs = [
            SELECT Final_Answer__c, IsStyled__c, Further_edited__c
            FROM Q_A_Question__c
            WHERE Q_A_Document__c = :documentId
              AND Status__c = 'Completed'
            WITH USER_MODE
        ];
        if (qs.isEmpty()) return 0;

        Set<Id> qIds = new Set<Id>();
        for (Q_A_Question__c q : qs) qIds.add(q.Id);

        Map<Id, String> selectedAnsByQ = new Map<Id, String>();
        for (Q_A_Answer__c a : [
                SELECT Q_A_Question__c, Answer__c
                FROM Q_A_Answer__c
                WHERE Q_A_Question__c IN :qIds
                  AND Is_Selected_Answer__c = true
                WITH USER_MODE
                ]) {
            if (!selectedAnsByQ.containsKey(a.Q_A_Question__c)) {
                selectedAnsByQ.put(a.Q_A_Question__c, a.Answer__c);
            }
        }

        Integer count = 0;
        for (Q_A_Question__c q : qs) {
            Boolean isCustom = selectedAnsByQ.containsKey(q.Id)
                && (norm(selectedAnsByQ.get(q.Id)) != norm(q.Final_Answer__c));
            if (isCustom || q.IsStyled__c == true || q.Further_edited__c == true) count++;
        }
        return count;
    }

    @AuraEnabled(cacheable=true)
    public static Integer getDraftCount(Id documentId) {
        if (documentId == null) return 0;
        return [
            SELECT COUNT()
            FROM Q_A_Question__c
            WHERE Q_A_Document__c = :documentId
              AND Status__c = 'Draft'
            WITH USER_MODE
        ];
    }

    @AuraEnabled(cacheable=true)
    public static Integer getUnansweredCount(Id documentId) {
        if (documentId == null) return 0;
        return [
            SELECT COUNT()
            FROM Q_A_Question__c
            WHERE Q_A_Document__c = :documentId
              AND Status__c = 'New'
            WITH USER_MODE
        ];
    }

    // New questions that have at least one repository match to pull from.
    @AuraEnabled(cacheable=true)
    public static Integer getBestMatchCount(Id documentId) {
        if (documentId == null) return 0;

        List<Q_A_Question__c> qs = [
            SELECT Id
            FROM Q_A_Question__c
            WHERE Q_A_Document__c = :documentId
              AND Status__c = 'New'
            WITH USER_MODE
        ];
        if (qs.isEmpty()) return 0;

        Set<Id> qIds = new Set<Id>();
        for (Q_A_Question__c q : qs) qIds.add(q.Id);

        Set<Id> withMatch = new Set<Id>();
        for (Q_A_Answer__c a : [
                SELECT Q_A_Question__c
                FROM Q_A_Answer__c
                WHERE Q_A_Question__c IN :qIds
                WITH USER_MODE
                ]) {
            withMatch.add(a.Q_A_Question__c);
        }
        return withMatch.size();
    }

    // Row label in the cover table, based on what's being downloaded.
    public String getCountLabel() {
        if (isMulti()) return 'Included Answers';
        String c = singleCat();
        if (c == 'strategic')      return 'Strategic Answers';
        if (c == 'strategicdraft') return 'Strategic Draft Answers';
        if (c == 'draft')          return 'Drafted Questions';
        if (c == 'unanswered')     return 'Unanswered Questions';
        if (c == 'bestmatch')      return 'Best-Match Answers';
        if (c == 'custom')         return 'Custom Edited Answers';
        return 'Finalized Answers';
    }

    // The count that matches the category — just the number, no "of total".
    public Integer getExportCount() {
        return (rows != null) ? rows.size() : 0;
    }

    // "Generated by ... " + date, shown together as one metadata value.
    public String getGeneratedSummary() {
        return generatedBy + '  \u00B7  ' + generatedDate;
    }

    // Singular noun for the category being exported.
    private String exportNoun() {
        if (isMulti()) return 'selected response';
        String c = singleCat();
        if (c == 'strategic')      return 'strategic response';
        if (c == 'strategicdraft') return 'strategic draft response';
        if (c == 'draft')          return 'drafted response';
        if (c == 'unanswered')     return 'unanswered question';
        if (c == 'bestmatch')      return 'best-match response';
        if (c == 'custom')         return 'custom edited response';
        return 'finalized response';
    }

    // Plain-words count sentence, e.g.
    // "This export contains 9 finalized responses out of 24 total questions."
    public String getExportSummarySentence() {
        Integer n     = getExportCount();
        String  noun  = exportNoun();
        String  what  = (n == 1) ? noun : noun + 's';
        String  qWord = (totalQuestions == 1) ? 'total question' : 'total questions';
        return 'This export contains ' + n + ' ' + what
             + ' out of ' + totalQuestions + ' ' + qWord + '.';
    }

    @AuraEnabled
    public static void logDownload(Id documentId, String category, Integer count) {
        if (documentId == null) return;

        // for a multi-category download, log the scope by its first component
        String first = (category != null && category.contains(','))
            ? category.split(',')[0].trim().toLowerCase()
            : (category == null ? '' : category.toLowerCase());

        String scope = first.startsWith('strategic') ? 'Strategic'
                     : (first == 'draft')            ? 'Draft'
                     : (first == 'unanswered')       ? 'Unanswered'
                     : (first == 'bestmatch')        ? 'Unanswered'
                     : 'Finalized';   // 'all' maps to Finalized

        // doc name + file type (same field the VF page uses to pick Word/Excel)
        String docNm   = '';
        String fileType = 'word';
        List<Q_A_Document__c> ds = [
            SELECT Name, File_Type__c
            FROM Q_A_Document__c
            WHERE Id = :documentId
            WITH USER_MODE
            LIMIT 1
        ];
        if (!ds.isEmpty()) {
            docNm    = ds[0].Name;
            fileType = (ds[0].File_Type__c != null) ? ds[0].File_Type__c.toLowerCase() : 'word';
        }

        // same rule as getIsExcel(): Excel if the type mentions exc/xls, else Word
        Boolean isExcel = fileType.contains('exc') || fileType.contains('xls');
        String fileFormat = isExcel ? 'Excel' : 'Word';

        // filename: latest related file's Title, else doc Name
        String fileName;
        List<ContentDocumentLink> links = [
            SELECT ContentDocument.Title
            FROM ContentDocumentLink
            WHERE LinkedEntityId = :documentId
            WITH USER_MODE
            ORDER BY SystemModstamp DESC
            LIMIT 1
        ];
        fileName = links.isEmpty() ? docNm : links[0].ContentDocument.Title;

        QnA_Download_Log__c log = new QnA_Download_Log__c(
            Q_A_Document__c   = documentId,
            Downloaded_By__c  = UserInfo.getUserId(),
            Download_On__c    = System.now(),
            Download_Scope__c = scope,
            File_Name__c      = fileName,
            File_Format__c    = fileFormat,
            Question_Count__c = (count == null ? 0 : count),
            Status__c         = 'Success'
        );

        Database.insert(
            Security.stripInaccessible(AccessType.CREATABLE,
                new List<QnA_Download_Log__c>{ log }).getRecords(),
            false   // never let a logging failure break the download
        );
    }

    private static String sanitizeHtml(String html) {
        if (String.isBlank(html)) return html;
        return html
            .replaceAll('(?i)<script[\\s\\S]*?>[\\s\\S]*?</script>', '')
            .replaceAll('(?i)<iframe[\\s\\S]*?>[\\s\\S]*?</iframe>', '')
            .replaceAll('(?i)<object[\\s\\S]*?>[\\s\\S]*?</object>', '')
            .replaceAll('(?i)<embed[^>]*>', '')
            .replaceAll('(?i)\\son\\w+\\s*=\\s*"[^"]*"', '')
            .replaceAll('(?i)\\son\\w+\\s*=\\s*\'[^\']*\'', '')
            .replaceAll('(?i)javascript\\s*:', '');
    }
}