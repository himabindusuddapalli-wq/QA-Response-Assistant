/**
 * @description Single controller behind the Q&A Response download feature.
 */
public with sharing class QnaDownloadController {

    // ===================== LWC (popup stats) =====================

    public class Stats {
        @AuraEnabled public String  documentName;
        @AuraEnabled public String  rfpName;
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
            LIMIT 1
        ];
        if (docs.isEmpty()) return s;

        Q_A_Document__c d = docs[0];
        s.documentName = d.Name;
        s.rfpName      = (d.RFP__r != null) ? d.RFP__r.Name : '';
        s.total        = (d.Total_Questions__c     != null) ? d.Total_Questions__c.intValue()     : 0;
        s.finalized    = (d.Finalized_Questions__c != null) ? d.Finalized_Questions__c.intValue() : 0;
        s.pending      = (d.Pending_Questions__c   != null) ? d.Pending_Questions__c.intValue()   : 0;
        return s;
    }

    // ===================== VF page (Word / Excel download) =====================

    public String  docName        { get; private set; }
    public String  rfpName        { get; private set; }
    public String  company        { get; private set; }
    public String  maName         { get; private set; }
    public String  category       { get; private set; }
    public String  fileTitle      { get; private set; }   // related file's Title
    public List<Row> rows         { get; private set; }

    // ---- export metadata (cover summary) ----
    public String  generatedBy    { get; private set; }
    public String  generatedOn    { get; private set; }
    public Integer totalQuestions { get; private set; }

    private String fileType;

    public class Row {
        public Decimal qNo      { get; set; }
        public String  section  { get; set; }
        public String  question { get; set; }
        public String  answer   { get; set; }
    }

    public QnaDownloadController() {
        rows           = new List<Row>();
        generatedBy    = UserInfo.getName();
        generatedOn    = System.now().format('MMM d, yyyy, h:mm a');
        totalQuestions = 0;

        Map<String, String> p = ApexPages.currentPage().getParameters();
        String idParam = p.get('id');
        category = String.isBlank(p.get('category')) ? 'all' : p.get('category');
        if (String.isNotBlank(idParam)) {
            loadRows((Id) idParam);
        }
    }

    private void loadRows(Id docId) {
        List<Q_A_Document__c> docs = [
            SELECT Name, File_Type__c, Total_Questions__c,
                   RFP__r.Name, Company__r.Name, Membership_Activity__r.Name
            FROM Q_A_Document__c
            WHERE Id = :docId
            LIMIT 1
        ];
        if (docs.isEmpty()) { fileType = 'word'; return; }

        Q_A_Document__c d = docs[0];
        docName        = d.Name;
        rfpName        = (d.RFP__r != null)                 ? d.RFP__r.Name : '';
        company        = (d.Company__r != null)             ? d.Company__r.Name : '';
        maName         = (d.Membership_Activity__r != null) ? d.Membership_Activity__r.Name : '';
        fileType       = (d.File_Type__c != null) ? d.File_Type__c.toLowerCase() : 'word';
        totalQuestions = (d.Total_Questions__c != null) ? d.Total_Questions__c.intValue() : 0;

        fileTitle = getRelatedFileTitle(docId);

        if (category == 'custom') {
            loadCustomRows(docId);
        } else {
            loadStandardRows(docId);
        }
    }

    // Latest file attached to the Q&A Document (Files/ContentDocumentLink)
    private static String getRelatedFileTitle(Id docId) {
        List<ContentDocumentLink> links = [
            SELECT ContentDocument.Title
            FROM ContentDocumentLink
            WHERE LinkedEntityId = :docId
            ORDER BY SystemModstamp DESC
            LIMIT 1
        ];
        return links.isEmpty() ? null : links[0].ContentDocument.Title;
    }

    // ---- all / strategic / draft : plain SOQL filter ----
    private void loadStandardRows(Id docId) {
        String statusFilter = (category == 'draft') ? 'Draft' : 'Completed';
        String extra        = (category == 'strategic') ? ' AND Strategy_Applied__c = true' : '';

        String soql =
            'SELECT QAQuestionNo__c, Section__c, QAQuestion__c, Final_Answer__c ' +
            'FROM Q_A_Question__c ' +
            'WHERE Q_A_Document__c = :docId ' +
            '  AND Status__c = :statusFilter' + extra + ' ' +
            'ORDER BY QAQuestionNo__c ASC NULLS LAST, Section__c ASC NULLS LAST';

        for (Q_A_Question__c q : Database.query(soql)) {
            addRow(q.QAQuestionNo__c, q.Section__c, q.QAQuestion__c, q.Final_Answer__c);
        }
    }

    // ---- custom : include if selected-answer differs from final, OR IsStyled, OR Further edited ----
    private void loadCustomRows(Id docId) {
        List<Q_A_Question__c> qs = [
            SELECT QAQuestionNo__c, Section__c, QAQuestion__c, Final_Answer__c,
                   IsStyled__c, Further_edited__c
            FROM Q_A_Question__c
            WHERE Q_A_Document__c = :docId
              AND Status__c = 'Completed'
            ORDER BY QAQuestionNo__c ASC NULLS LAST, Section__c ASC NULLS LAST
        ];
        if (qs.isEmpty()) return;

        Set<Id> qIds = new Set<Id>();
        for (Q_A_Question__c q : qs) qIds.add(q.Id);

        Map<Id, String> selectedAnsByQ = new Map<Id, String>();
        for (Q_A_Answer__c a : [
                SELECT Q_A_Question__c, Answer__c
                FROM Q_A_Answer__c
                WHERE Q_A_Question__c IN :qIds
                  AND Is_Selected_Answer__c = true ]) {
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

    private void addRow(Decimal qNo, String section, String question, String answer) {
        Row r      = new Row();
        r.qNo      = qNo;
        r.section  = section;
        r.question = question;
        r.answer   = answer;
        rows.add(r);
    }

    private static String norm(String s) {
        if (String.isBlank(s)) return '';
        return s.replaceAll('<[^>]+>', ' ')
                .replaceAll('&[a-zA-Z0-9#]+;', ' ')
                .replaceAll('\\s+', ' ')
                .trim();
    }

    public Boolean getIsExcel() {
        if (fileType == null) return false;
        return fileType.contains('exc') || fileType.contains('xls');
    }
    public Boolean getIsWord() { return !getIsExcel(); }

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
        ];
        if (qs.isEmpty()) return;

        Set<Id> qIds = new Set<Id>();
        for (Q_A_Question__c q : qs) qIds.add(q.Id);

        Map<Id, String> selectedAnsByQ = new Map<Id, String>();
        for (Q_A_Answer__c a : [
                SELECT Q_A_Question__c, Answer__c
                FROM Q_A_Answer__c
                WHERE Q_A_Question__c IN :qIds
                  AND Is_Selected_Answer__c = true ]) {
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
            'total' => 0, 'completed' => 0, 'strategic' => 0
        };
        if (documentId == null) return m;

        for (Q_A_Question__c q : [
                SELECT Status__c, Strategy_Applied__c
                FROM Q_A_Question__c
                WHERE Q_A_Document__c = :documentId ]) {
            m.put('total', m.get('total') + 1);
            Boolean done = (q.Status__c == 'Completed');
            if (done) m.put('completed', m.get('completed') + 1);
            if (done && q.Strategy_Applied__c == true) m.put('strategic', m.get('strategic') + 1);
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
        ];
        if (qs.isEmpty()) return 0;

        Set<Id> qIds = new Set<Id>();
        for (Q_A_Question__c q : qs) qIds.add(q.Id);

        Map<Id, String> selectedAnsByQ = new Map<Id, String>();
        for (Q_A_Answer__c a : [
                SELECT Q_A_Question__c, Answer__c
                FROM Q_A_Answer__c
                WHERE Q_A_Question__c IN :qIds
                  AND Is_Selected_Answer__c = true ]) {
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
        ];
    }
}