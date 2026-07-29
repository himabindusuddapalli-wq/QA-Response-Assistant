/**
 * @description       : Fetches top-3 Data Cloud answers for a Q&A question and persists them as Q_A_Answer__c records.
 * @author            : Ambika
 * @last modified on  : 07-16-2026
**/
public with sharing class QnaAnswerSearchController {

    @TestVisible
    private static IDataCloudService dataCloudService = new DataCloudService();

    // ── Public API ──────────────────────────────────────────────────────────

    @AuraEnabled
    public static List<Q_A_Answer__c> getAnswersForQuestion(Id questionId, String questionText) {
        try {
            return [
                SELECT Id, Answer__c, Company__c, Consulting_Firm__c,
                       Effective_Period__c, File_Name__c, Industry__c,
                       Match_Score__c, Vector_Score__c, Keyword_Score__c,
                       RFP_Name__c, SVP_Name__c,
                       Topic_Area__c, Is_Selected_Answer__c, D360_Data_Source_ID__c
                FROM Q_A_Answer__c
                WHERE Q_A_Question__c = :questionId
                WITH USER_MODE
                ORDER BY Match_Score__c DESC
                LIMIT 3
            ];
        } catch (Exception e) {
            throw new AuraHandledException(e.getMessage());
        }
    }

    // Public so QnaAnswerSearchBatchProcessor can call it directly
    public static List<Q_A_Answer__c> fetchAndStoreAnswers(Id questionId, String questionText) {
        return fetchAndStoreAnswers(questionId, questionText, null);
    }

    public static List<Q_A_Answer__c> fetchAndStoreAnswers(Id questionId, String questionText, String preferredConsultingFirm) {
        List<Q_A_Answer__c> result = new List<Q_A_Answer__c>();

        List<Q_A_Response_Assistant__mdt> cfgList = [
            SELECT QA_SQL_Query__c,
                   QA_Question_Field_API_Name__c,
                   QA_Answer_Field_API_Name__c,
                   QA_Hybrid_Score_Field_API_Name__c,
                   QA_Vector_Score_Field_API_Name__c,
                   QA_Keyword_Score_Field_API_Name__c,
                   QA_Date_Field_API_Name__c,
                   QA_Company_Field_API_Name__c,
                   QA_Consulting_Firm_Field_API_Name__c,
                   QA_RFP_Field_API_Name__c,
                   QA_Industry_Field_API_Name__c,
                   QA_SVP_Name_Field_API_Name__c,
                   QA_Topic_Area_Field_API_Name__c
            FROM Q_A_Response_Assistant__mdt
            WHERE DeveloperName = 'Q_A_Response_Assistant'
            LIMIT 1
        ];
        if (cfgList.isEmpty()) return result;
        Q_A_Response_Assistant__mdt cfg = cfgList[0];

        if (String.isBlank(cfg.QA_SQL_Query__c) || !cfg.QA_SQL_Query__c.contains('{{QUESTION}}')) {
            return result;
        }

        String safeQuestion = questionText.trim().replace('\'', '\'\'');
        String finalSql = cfg.QA_SQL_Query__c
            .replace('{{QUESTION}}', safeQuestion)
            .replaceAll('[\\n\\r]+', ' ');

        ConnectApi.CdpQueryOutputV2 output;
        try {
            output = dataCloudService.runQuery(finalSql);
        } catch (Exception e) {
            System.debug('QnaAnswerSearch Data Cloud query failed: ' + e.getMessage());
            return result;
        }

        if (output == null || output.data == null || output.data.isEmpty()) return result;

        // Resolve column positions from metadata
        Map<String, Integer> colMap = new Map<String, Integer>();
        for (String colName : output.metadata.keySet()) {
            ConnectApi.CdpQueryMetadataItem meta = (ConnectApi.CdpQueryMetadataItem) output.metadata.get(colName);
            if (meta != null && meta.placeInOrder != null) {
                colMap.put(colName, meta.placeInOrder);
            }
        }

        Integer questionIdx = colMap.get(cfg.QA_Question_Field_API_Name__c);
        Integer answerIdx   = colMap.get(cfg.QA_Answer_Field_API_Name__c);
        Integer hybridIdx   = colMap.get(cfg.QA_Hybrid_Score_Field_API_Name__c);
        Integer vectorIdx   = colMap.get(cfg.QA_Vector_Score_Field_API_Name__c);
        Integer keywordIdx  = colMap.get(cfg.QA_Keyword_Score_Field_API_Name__c);
        Integer dateIdx     = colMap.get(cfg.QA_Date_Field_API_Name__c);
        Integer companyIdx  = colMap.get(cfg.QA_Company_Field_API_Name__c);
        Integer firmIdx     = colMap.get(cfg.QA_Consulting_Firm_Field_API_Name__c);
        Integer rfpIdx      = colMap.get(cfg.QA_RFP_Field_API_Name__c);
        Integer industryIdx = colMap.get(cfg.QA_Industry_Field_API_Name__c);
        Integer svpIdx      = colMap.get(cfg.QA_SVP_Name_Field_API_Name__c);
        Integer topicIdx    = colMap.get(cfg.QA_Topic_Area_Field_API_Name__c);

        if (hybridIdx == null || answerIdx == null) return result;

        // Build candidate list from all rows returned by Data Cloud
        List<AnswerCandidate> candidates = new List<AnswerCandidate>();

        for (ConnectApi.CdpQueryV2Row row : output.data) {
            List<Object> cols = row.rowData;

            Decimal hybridScore = Decimal.valueOf((String) cols[hybridIdx]).setScale(2);

            Q_A_Answer__c ans = new Q_A_Answer__c();
            ans.Q_A_Question__c        = questionId;
            ans.Answer__c              = (String) cols[answerIdx];
            ans.Match_Score__c         = hybridScore;
            ans.D360_Data_Source_ID__c = questionIdx != null ? (String) cols[questionIdx] : null;

            if (vectorIdx  != null && cols[vectorIdx]  != null) ans.Vector_Score__c  = Decimal.valueOf((String) cols[vectorIdx]).setScale(2);
            if (keywordIdx != null && cols[keywordIdx] != null) ans.Keyword_Score__c = Decimal.valueOf((String) cols[keywordIdx]).setScale(2);

            if (dateIdx     != null && cols[dateIdx]     != null) ans.Effective_Period__c = String.valueOf(cols[dateIdx]);
            if (companyIdx  != null && cols[companyIdx]  != null) ans.Company__c          = String.valueOf(cols[companyIdx]);
            if (firmIdx     != null && cols[firmIdx]     != null) ans.Consulting_Firm__c  = String.valueOf(cols[firmIdx]);
            if (rfpIdx      != null && cols[rfpIdx]      != null) ans.RFP_Name__c         = String.valueOf(cols[rfpIdx]);
            if (industryIdx != null && cols[industryIdx] != null) ans.Industry__c         = String.valueOf(cols[industryIdx]);
            if (svpIdx      != null && cols[svpIdx]      != null) ans.SVP_Name__c         = String.valueOf(cols[svpIdx]);
            if (topicIdx    != null && cols[topicIdx]    != null) ans.Topic_Area__c       = String.valueOf(cols[topicIdx]);

            Boolean firmMatch = String.isNotBlank(preferredConsultingFirm)
                && String.isNotBlank(ans.Consulting_Firm__c)
                && ans.Consulting_Firm__c.equalsIgnoreCase(preferredConsultingFirm);

            candidates.add(new AnswerCandidate(ans, firmMatch));
        }

        // Rank: (1) hybrid score desc, (2) same consulting firm first, (3) recency desc
        candidates.sort();

        List<Q_A_Answer__c> toInsert = new List<Q_A_Answer__c>();
        Set<String> seenAnswers = new Set<String>();
        for (AnswerCandidate c : candidates) {
            if (toInsert.size() >= 3) break;
            String answerKey = c.rec.Answer__c != null ? c.rec.Answer__c.left(200).normalizeSpace() : '';
            if (seenAnswers.contains(answerKey)) continue;
            seenAnswers.add(answerKey);
            toInsert.add(c.rec);
        }

        if (!toInsert.isEmpty()) {
            // Remove any existing answers before inserting so re-runs replace, not append
            List<Q_A_Answer__c> existing = [
                SELECT Id FROM Q_A_Answer__c
                WHERE Q_A_Question__c = :questionId
                WITH USER_MODE
            ];
            if (!existing.isEmpty()) delete existing;

            insert toInsert;
            result = toInsert;
        }
        return result;
    }

    // ── Inner class for sorting ─────────────────────────────────────────────

    private class AnswerCandidate implements Comparable {
        Q_A_Answer__c rec;
        Boolean firmMatch;

        AnswerCandidate(Q_A_Answer__c r, Boolean fm) {
            rec       = r;
            firmMatch = fm;
        }

        public Integer compareTo(Object other) {
            AnswerCandidate o = (AnswerCandidate) other;

            // 1. Higher hybrid score first
            Decimal myScore = rec.Match_Score__c != null ? rec.Match_Score__c : 0;
            Decimal otScore = o.rec.Match_Score__c != null ? o.rec.Match_Score__c : 0;
            if (myScore != otScore) return myScore > otScore ? -1 : 1;

            // 2. Same consulting firm as the document's preferred firm first
            if (firmMatch != o.firmMatch) return firmMatch ? -1 : 1;

            // 3. More recent effective date first (ISO string — lexicographic desc)
            String myDate = rec.Effective_Period__c != null ? rec.Effective_Period__c : '';
            String otDate = o.rec.Effective_Period__c != null ? o.rec.Effective_Period__c : '';
            if (myDate != otDate) return myDate > otDate ? -1 : 1;

            return 0;
        }
    }
}