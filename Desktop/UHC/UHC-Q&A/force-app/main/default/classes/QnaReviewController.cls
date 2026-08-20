public with sharing class QnaReviewController {

    public class QuestionWrapper implements Comparable {
        @AuraEnabled public Id id;
        @AuraEnabled public String questionText;
        @AuraEnabled public String questionNumber;
        @AuraEnabled public String section;
        @AuraEnabled public String status;
        @AuraEnabled public String finalAnswer;
        @AuraEnabled public Boolean strategyApplied;
        @AuraEnabled public Boolean isStyled;
        @AuraEnabled public Boolean isStarred;
        @AuraEnabled public Boolean matchUsed;
        @AuraEnabled public String finalisedBy;
        @AuraEnabled public String answerSizeLimit;
        @AuraEnabled public Id assignedToId;
        @AuraEnabled public String assignedToName;

        public Integer compareTo(Object other) {
            QuestionWrapper w = (QuestionWrapper) other;
            List<String> segsA = (this.questionNumber != null ? this.questionNumber : '').split('\\.');
            List<String> segsB = (w.questionNumber    != null ? w.questionNumber    : '').split('\\.');
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

    @AuraEnabled(cacheable=true)
    public static Map<String, Object> getReviewData(Id documentId) {
        Map<String, Object> result = new Map<String, Object>();

        Q_A_Document__c doc = [
            SELECT Id, Name, Membership_Activity__c, Membership_Activity__r.Name
            FROM Q_A_Document__c
            WHERE Id = :documentId
            LIMIT 1
        ];
        result.put('documentName', doc.Name);
        result.put('membershipActivityName', doc.Membership_Activity__r.Name);

        List<QuestionWrapper> questions = new List<QuestionWrapper>();
        for (Q_A_Question__c q : [
            SELECT Id, QAQuestion__c, QAQuestionNo__c, Section__c, Status__c, Final_Answer__c, Strategy_Applied__c, IsStyled__c, Is_Starred__c, Finalized_By__c, Answer_Size_Limit__c, Match_Used__c, Assigned_To__c, Assigned_To__r.Name
            FROM Q_A_Question__c
            WHERE Q_A_Document__c = :documentId
            ORDER BY Id ASC
        ]) {
            QuestionWrapper w = new QuestionWrapper();
            w.id = q.Id;
            w.questionText = q.QAQuestion__c;
            w.questionNumber = q.QAQuestionNo__c;
            w.section = q.Section__c;
            w.status = q.Status__c;
            w.finalAnswer = q.Final_Answer__c;
            w.strategyApplied = q.Strategy_Applied__c;
            w.isStyled        = q.IsStyled__c;
            w.isStarred       = q.Is_Starred__c;
            w.matchUsed       = q.Match_Used__c;
            w.finalisedBy     = q.Finalized_By__c;
            w.answerSizeLimit = q.Answer_Size_Limit__c;
            w.assignedToId    = q.Assigned_To__c;
            w.assignedToName  = q.Assigned_To__r != null ? q.Assigned_To__r.Name : null;
            questions.add(w);
        }
        result.put('questions', questions);
        return result;
    }

    // matchUsed is nullable: when null the field is left untouched (used by the
    // reopen status-flip so it doesn't clobber the stored origin). When non-null
    // it reflects where the working answer came from — true = Select & Edit,
    // false = Draft New.
    @AuraEnabled
    public static void saveAnswer(Id questionId, String answer, String status, Boolean matchUsed) {
        try {
            Q_A_Question__c q = new Q_A_Question__c(
                Id              = questionId,
                Final_Answer__c = answer,
                Status__c       = status,
                Is_Finalized__c = (status == 'Completed')
            );
            if (matchUsed != null) {
                q.Match_Used__c = matchUsed;
            }
            if (status == 'Completed') {
                q.Is_Starred__c   = false;
                q.Finalized_By__c = UserInfo.getName();
            }
            update q;
            recalculateDocumentCounts(questionId);
        } catch (Exception e) {
            throw new AuraHandledException('Failed to save answer: ' + e.getMessage());
        }
    }

    // Recalculates Finalized/Pending question counts on the parent Q_A_Document__c
    // after a question's status changes, and advances the document status from
    // "Digitization Successful" to "Review In-Progress" on the first answer save.
    private static void recalculateDocumentCounts(Id questionId) {
        Q_A_Question__c q = [
            SELECT Q_A_Document__c, Q_A_Document__r.Status__c
            FROM Q_A_Question__c
            WHERE Id = :questionId
            LIMIT 1
        ];
        if (q.Q_A_Document__c == null) return;

        Integer total     = 0;
        Integer finalized  = 0;
        for (AggregateResult ar : [
            SELECT Status__c status, COUNT(Id) cnt
            FROM Q_A_Question__c
            WHERE Q_A_Document__c = :q.Q_A_Document__c
            GROUP BY Status__c
        ]) {
            Integer cnt = (Integer) ar.get('cnt');
            total += cnt;
            if ((String) ar.get('status') == 'Completed') finalized += cnt;
        }

        String currentStatus = q.Q_A_Document__r.Status__c;
        String newStatus = (currentStatus == 'Digitization Successful')
            ? 'Review In-Progress'
            : currentStatus;

        update new Q_A_Document__c(
            Id                     = q.Q_A_Document__c,
            Status__c              = newStatus,
            Finalized_Questions__c = finalized,
            Pending_Questions__c   = total - finalized
        );
    }

    // @AuraEnabled(cacheable=true)
    // public static Map<String, List<String>> getRepositoryFilterOptions() {
    //     Map<String, Set<String>> seen = new Map<String, Set<String>>{
    //         'company'        => new Set<String>(),
    //         'consultingFirm' => new Set<String>(),
    //         'fileName'       => new Set<String>(),
    //         'industry'       => new Set<String>(),
    //         'rfpName'        => new Set<String>(),
    //         'svpName'        => new Set<String>(),
    //         'topicArea'      => new Set<String>()
    //     };

    //     for (Q_A_Document_Repository__c r : [
    //         SELECT Company__c, ConsultingFirm__c, FileName__c,
    //                Industry__c, RFPName__c, SVPName__c, TopicArea__c
    //         FROM Q_A_Document_Repository__c
    //         LIMIT 5000
    //     ]) {
    //         if (String.isNotBlank(r.Company__c))        seen.get('company').add(r.Company__c.trim());
    //         if (String.isNotBlank(r.ConsultingFirm__c)) seen.get('consultingFirm').add(r.ConsultingFirm__c.trim());
    //         if (String.isNotBlank(r.FileName__c))       seen.get('fileName').add(r.FileName__c.trim());
    //         if (String.isNotBlank(r.Industry__c))       seen.get('industry').add(r.Industry__c.trim());
    //         if (String.isNotBlank(r.RFPName__c))        seen.get('rfpName').add(r.RFPName__c.trim());
    //         if (String.isNotBlank(r.SVPName__c))        seen.get('svpName').add(r.SVPName__c.trim());
    //         if (String.isNotBlank(r.TopicArea__c))      seen.get('topicArea').add(r.TopicArea__c.trim());
    //     }

    //     Map<String, List<String>> result = new Map<String, List<String>>();
    //     for (String key : seen.keySet()) {
    //         List<String> vals = new List<String>(seen.get(key));
    //         vals.sort();
    //         result.put(key, vals);
    //     }
    //     return result;
    // }

    @AuraEnabled
    public static void markSelectedAnswer(Id questionId, Id answerId) {
        if (questionId == null || answerId == null) return;
        try {
            List<Q_A_Answer__c> toUpdate = new List<Q_A_Answer__c>();
            for (Q_A_Answer__c a : [
                SELECT Id, Is_Selected_Answer__c
                FROM Q_A_Answer__c
                WHERE Q_A_Question__c = :questionId
            ]) {
                Boolean shouldSelect = (a.Id == answerId);
                if (a.Is_Selected_Answer__c != shouldSelect) {
                    a.Is_Selected_Answer__c = shouldSelect;
                    toUpdate.add(a);
                }
            }
            if (!toUpdate.isEmpty()) update toUpdate;
        } catch (Exception e) {
            throw new AuraHandledException('Failed to mark selected answer: ' + e.getMessage());
        }
    }

    @AuraEnabled
    public static void toggleStar(Id questionId, Boolean starred) {
        if (questionId == null) return;
        try {
            update new Q_A_Question__c(Id = questionId, Is_Starred__c = starred);
        } catch (Exception e) {
            throw new AuraHandledException('Failed to update star: ' + e.getMessage());
        }
    }

    // ── Team Management ───────────────────────────────────────────────────────

    public class TeamMemberWrapper {
        @AuraEnabled public Id id;
        @AuraEnabled public Id userId;
        @AuraEnabled public String userName;
        @AuraEnabled public String role;
    }

    @AuraEnabled(cacheable=false)
    public static List<TeamMemberWrapper> getDocumentTeam(Id documentId) {
        List<TeamMemberWrapper> result = new List<TeamMemberWrapper>();
        for (Q_A_Document_Team__c tm : [
            SELECT Id, Team_Member__c, Team_Member__r.Name, Role__c
            FROM Q_A_Document_Team__c
            WHERE Document__c = :documentId
            ORDER BY CreatedDate ASC
        ]) {
            TeamMemberWrapper w = new TeamMemberWrapper();
            w.id       = tm.Id;
            w.userId   = tm.Team_Member__c;
            w.userName = tm.Team_Member__r.Name;
            w.role     = tm.Role__c;
            result.add(w);
        }
        return result;
    }

    @AuraEnabled
    public static Id saveTeamMember(Id documentId, Id userId, String role) {
        try {
            List<Q_A_Document_Team__c> existing = [
                SELECT Id FROM Q_A_Document_Team__c
                WHERE Document__c = :documentId AND Team_Member__c = :userId
                LIMIT 1
            ];
            Q_A_Document_Team__c tm;
            if (!existing.isEmpty()) {
                tm = new Q_A_Document_Team__c(Id = existing[0].Id, Role__c = role);
            } else {
                tm = new Q_A_Document_Team__c(
                    Document__c    = documentId,
                    Team_Member__c = userId,
                    Role__c        = role
                );
            }
            upsert tm;
            return tm.Id;
        } catch (Exception e) {
            throw new AuraHandledException('Failed to save team member: ' + e.getMessage());
        }
    }

    @AuraEnabled
    public static void removeTeamMember(Id teamMemberId) {
        try {
            delete new Q_A_Document_Team__c(Id = teamMemberId);
        } catch (Exception e) {
            throw new AuraHandledException('Failed to remove team member: ' + e.getMessage());
        }
    }

    @AuraEnabled(cacheable=false)
    public static List<Map<String, String>> getTeamUsersForLookup(Id documentId) {
        List<Map<String, String>> result = new List<Map<String, String>>();
        for (Q_A_Document_Team__c tm : [
            SELECT Team_Member__c, Team_Member__r.Name
            FROM Q_A_Document_Team__c
            WHERE Document__c = :documentId
            ORDER BY Team_Member__r.Name ASC
        ]) {
            result.add(new Map<String, String>{
                'id'   => tm.Team_Member__c,
                'name' => tm.Team_Member__r.Name
            });
        }
        return result;
    }

    @AuraEnabled
    public static void assignQuestion(Id questionId, Id userId) {
        try {
            update new Q_A_Question__c(Id = questionId, Assigned_To__c = userId);
        } catch (Exception e) {
            throw new AuraHandledException('Failed to assign question: ' + e.getMessage());
        }
    }

    @AuraEnabled
    public static void bulkAssignQuestions(List<Id> questionIds, List<String> userIds) {
        try {
            List<Q_A_Question__c> toUpdate = new List<Q_A_Question__c>();
            for (Integer i = 0; i < questionIds.size(); i++) {
                String uid = userIds[i];
                toUpdate.add(new Q_A_Question__c(
                    Id = questionIds[i],
                    Assigned_To__c = String.isNotBlank(uid) ? (Id) uid : null
                ));
            }
            update toUpdate;
        } catch (Exception e) {
            throw new AuraHandledException('Failed to save assignments: ' + e.getMessage());
        }
    }

    @AuraEnabled(cacheable=false)
    public static List<Map<String, String>> searchUsers(String searchTerm) {
        List<Map<String, String>> result = new List<Map<String, String>>();
        if (String.isBlank(searchTerm) || searchTerm.length() < 2) return result;
        String q = '%' + searchTerm + '%';
        for (User u : [
            SELECT Id, Name
            FROM User
            WHERE IsActive = true AND (Name LIKE :q OR Email LIKE :q)
            ORDER BY Name ASC
            LIMIT 10
        ]) {
            result.add(new Map<String, String>{ 'id' => u.Id, 'name' => u.Name });
        }
        return result;
    }

   @AuraEnabled(cacheable=true)
    public static Map<String, List<String>> getRepositoryFilterOptions() {
        Map<String, Set<String>> seen = new Map<String, Set<String>>{
            'company'        => new Set<String>(),
            'consultingFirm' => new Set<String>(),
            'fileName'       => new Set<String>(),
            'industry'       => new Set<String>(),
            'rfpName'        => new Set<String>(),
            'svpName'        => new Set<String>(),
            'topicArea'      => new Set<String>()
        };

        // File Name and Topic Area still come from the repository (unchanged).
        // RFP repository values are ALSO kept here and unioned with org RFP records below.
        for (Q_A_Document_Repository__c r : [
            SELECT Company__c, ConsultingFirm__c, FileName__c,
                   Industry__c, RFPName__c, SVPName__c, TopicArea__c
            FROM Q_A_Document_Repository__c
            LIMIT 5000
        ]) {
            if (String.isNotBlank(r.FileName__c))  seen.get('fileName').add(r.FileName__c.trim());
            if (String.isNotBlank(r.RFPName__c))   seen.get('rfpName').add(r.RFPName__c.trim());
            if (String.isNotBlank(r.TopicArea__c)) seen.get('topicArea').add(r.TopicArea__c.trim());
        }

        // SVP values come from org Users with the CD SVP role (active only).
        // Filtering itself still runs against Data Cloud unchanged — this only
        // changes which values appear in the dropdown.
        for (User u : [
            SELECT Name
            FROM User
            WHERE IsActive = true AND UserRole.Name = 'CD SVP'
            ORDER BY Name
        ]) {
            if (String.isNotBlank(u.Name)) seen.get('svpName').add(u.Name.trim());
        }

        // Industry values come from the Health_Plan_Manager_Industry__c picklist
        // on the Account (Company) object. Filtering still runs against Data Cloud
        // unchanged — this only changes which values appear in the dropdown.
        for (Schema.PicklistEntry ple :
                Account.Health_Plan_Manager_Industry__c.getDescribe().getPicklistValues()) {
            if (ple.isActive() && String.isNotBlank(ple.getValue())) {
                seen.get('industry').add(ple.getValue().trim());
            }
        }

        // Company values come from Account records with the client / prospect
        // record types. Filtering still runs against Data Cloud unchanged — this
        // only changes which values appear in the dropdown.
        for (Account a : [
            SELECT Name
            FROM Account
            WHERE RecordType.DeveloperName IN
                ('Existing_Client','Prospect','Client_Subsidiary','Prospect_Subsidiary','Sold_Client')
            ORDER BY Name
            LIMIT 50000
        ]) {
            if (String.isNotBlank(a.Name)) seen.get('company').add(a.Name.trim());
        }

        // Consulting Firm values come from Account records with the Consulting_Firm
        // record type. Filtering still runs against Data Cloud unchanged — this only
        // changes which values appear in the dropdown.
        for (Account a : [
            SELECT Name
            FROM Account
            WHERE RecordType.DeveloperName = 'Consulting_Firm'
            ORDER BY Name
            LIMIT 50000
        ]) {
            if (String.isNotBlank(a.Name)) seen.get('consultingFirm').add(a.Name.trim());
        }

        // RFP values: existing repository RFP names (added above) PLUS the org's
        // RFP__c records shown by their autonumber Name (e.g. RFP-0041). The Set
        // dedups any overlap. NOTE: org RFP autonumbers won't match Data Cloud's
        // readable RFP_Name__c values, so selecting one may return zero matches.
        for (RFP__c rfp : [
            SELECT Name
            FROM RFP__c
            ORDER BY Name
            LIMIT 50000
        ]) {
            if (String.isNotBlank(rfp.Name)) seen.get('rfpName').add(rfp.Name.trim());
        }

        Map<String, List<String>> result = new Map<String, List<String>>();
        for (String key : seen.keySet()) {
            List<String> vals = new List<String>(seen.get(key));
            vals.sort();
            result.put(key, vals);
        }
        return result;
    }
}