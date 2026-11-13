#pragma once

#include <dataflow/callgraph.hpp>
#include <dataflow/outline.hpp>

/*
  The sites of the members of a type, from the index of the uses of the call graph:
    > a class, a struct or a union: the functions of the project that use its data members. each function has the
      members that it uses and the members that it writes. the function with the most members comes first, because a
      function that loads, saves or copies the type uses most members
    > an enum: each switch statement on the enum, with the enumerators that it does not handle and hasDefault. the
      enumerators come from the type in the translation unit of the request. thus a new enumerator that the last scan
      did not see is missing in each switch
    > the facts of the types of a file for the heat: for each data member, the functions that read it and the functions
      that write it, the files of these functions, and the user on the shortest frame path
  A type that the index does not know, for example a new type, has no sites.
*/

namespace DataFlow {

  // the functions of the sites of a type, and the users of a member in the facts of the heat
  inline constexpr size_t sites_max_functions = 200;
  inline constexpr size_t sites_max_users     = 20;

  namespace Detail {
    // the data members of a record with a name, in the sequence of the source. with _isStatic, also the static data
    // members
    [[nodiscard]] inline std::vector<const clang::ValueDecl*> record_members(const clang::RecordDecl& _rd,
                                                                             const bool _isStatic) {
      std::vector<const clang::ValueDecl*> out;
      for (const clang::Decl* d : _rd.decls()) {
        const auto* v = llvm::dyn_cast<clang::ValueDecl>(d);
        if (!v || !v->getIdentifier() || v->isImplicit()) continue;
        const auto* var = llvm::dyn_cast<clang::VarDecl>(v);
        if (llvm::isa<clang::FieldDecl>(v) || (_isStatic && var && var->isStaticDataMember())) out.push_back(v);
      }
      return out;
    }  // record_members

    // the number of the usr of a declaration in the names of the index, or nullopt if no scan saw it
    [[nodiscard]] inline std::optional<uint32_t> index_name_of(const ProjectGraph& _g, const clang::Decl& _d) {
      const std::string usr = usr_of(_d);
      return usr.empty() ? std::nullopt : _g.names_->find(usr);
    }  // index_name_of

    [[nodiscard]] inline const GraphUse* use_of(const GraphFunction& _f, const uint32_t _name) {
      const auto it = std::ranges::find(_f.uses_, _name, &GraphUse::name_);
      return it != _f.uses_.end() ? &*it : nullptr;
    }  // use_of

    [[nodiscard]] inline uint32_t expansion_line(const clang::SourceManager& _sm, const clang::SourceLocation _loc) {
      return _sm.getExpansionLineNumber(_sm.getExpansionLoc(_loc));
    }  // expansion_line

    // the records with a definition in the main file: the classes, the structs and the unions in the namespaces and
    // in other records, with a name. no lambdas, and no instantiations of templates
    template <class IsIn>
    inline void collect_records(const clang::Decl* _decl, const IsIn& _isIn,
                                std::vector<const clang::RecordDecl*>& _out) {
      const clang::Decl* d = _decl;
      if (const auto* t = llvm::dyn_cast<clang::ClassTemplateDecl>(d)) d = t->getTemplatedDecl();
      if (llvm::isa<clang::ClassTemplateSpecializationDecl>(d) || !_isIn(d->getLocation())) return;
      if (const auto* rd = llvm::dyn_cast<clang::CXXRecordDecl>(d)) {
        if (rd->isLambda() || rd->isInjectedClassName() || !rd->isThisDeclarationADefinition()) return;
        if (rd->getIdentifier()) _out.push_back(rd);
      } else if (const auto* rd = llvm::dyn_cast<clang::RecordDecl>(d)) {
        if (rd->isThisDeclarationADefinition() && rd->getIdentifier()) _out.push_back(rd);
        return;
      } else if (!llvm::isa<clang::NamespaceDecl, clang::LinkageSpecDecl, clang::ExportDecl>(d)) {
        return;
      }
      for (const clang::Decl* child : llvm::cast<clang::DeclContext>(d)->decls()) collect_records(child, _isIn, _out);
    }  // collect_records
  }  // namespace Detail

  // the classes, the structs and the unions with a definition in the main file, in the sequence of the source
  [[nodiscard]] inline std::vector<const clang::RecordDecl*> main_file_records(clang::ASTUnit& _ast) {
    std::vector<const clang::RecordDecl*> out;
    const auto isIn = Detail::main_file_test(_ast.getSourceManager());
    for (auto it = _ast.top_level_begin(); it != _ast.top_level_end(); ++it) Detail::collect_records(*it, isIn, out);
    return out;
  }  // main_file_records

  // the name, the kind, the file and the line of a type
  [[nodiscard]] inline JsonObject tag_to_json(const clang::TagDecl& _tag) {
    const clang::SourceManager& sm = _tag.getASTContext().getSourceManager();
    return JsonObject{{"name", _tag.getQualifiedNameAsString()},
                      {"kind", Detail::tag_kind(_tag)},
                      {"file", Detail::file_of(sm, _tag.getLocation())},
                      {"line", int64_t(Detail::expansion_line(sm, _tag.getLocation()))}};
  }  // tag_to_json

  // the functions that use the data members of a record, the most members first. with no graph, only the members
  [[nodiscard]] inline JsonObject record_sites_to_json(const ProjectGraph* _g, const clang::RecordDecl& _rd) {
    const std::vector<const clang::ValueDecl*> members = Detail::record_members(_rd, false);
    JsonArray names;
    for (const clang::ValueDecl* m : members) names.push_back(m->getNameAsString());
    JsonObject out{{"members", std::move(names)}};
    if (!_g) return out;

    // the members that each function uses and writes, as indexes in members
    struct Site {
      int32_t node_ = -1;
      std::vector<size_t> uses_;
      std::vector<size_t> writes_;
    };  // Site
    std::unordered_map<int32_t, Site> sites;
    for (size_t m = 0; m < members.size(); ++m) {
      const std::optional<uint32_t> name = Detail::index_name_of(*_g, *members[m]);
      const auto users                   = name ? _g->usersOf_.find(*name) : _g->usersOf_.end();
      if (users == _g->usersOf_.end()) continue;
      for (const int32_t n : users->second) {
        Site& s = sites.try_emplace(n, Site{n, {}, {}}).first->second;
        s.uses_.push_back(m);
        if (const GraphUse* u = Detail::use_of(*_g->nodes_[size_t(n)], *name); u && u->isWrite_) s.writes_.push_back(m);
      }
    }
    std::vector<const Site*> list;
    for (const auto& [n, s] : sites) list.push_back(&s);
    std::ranges::sort(list, [&](const Site* _a, const Site* _b) {
      if (_a->uses_.size() != _b->uses_.size()) return _a->uses_.size() > _b->uses_.size();
      return _g->nodes_[size_t(_a->node_)]->name_ < _g->nodes_[size_t(_b->node_)]->name_;
    });

    JsonArray functions;
    for (size_t i = 0; i < list.size() && i < sites_max_functions; ++i) {
      const GraphFunction& f = *_g->nodes_[size_t(list[i]->node_)];
      JsonArray uses, writes;
      for (const size_t m : list[i]->uses_) uses.push_back(members[m]->getNameAsString());
      for (const size_t m : list[i]->writes_) writes.push_back(members[m]->getNameAsString());
      functions.push_back(JsonObject{{"name", f.name_},
                                     {"file", f.file_},
                                     {"first", int64_t(f.first_)},
                                     {"last", int64_t(f.last_)},
                                     {"uses", std::move(uses)},
                                     {"writes", std::move(writes)}});
    }
    out["functions"] = std::move(functions);
    if (list.size() > sites_max_functions) out["isCapped"] = true;
    return out;
  }  // record_sites_to_json

  // each switch statement on an enum, with the enumerators that it does not handle. the switches with a missing
  // enumerator come first. with no graph, only the enumerators
  [[nodiscard]] inline JsonObject enum_sites_to_json(const ProjectGraph* _g, const clang::EnumDecl& _e) {
    std::vector<std::string> enumerators;
    for (const clang::EnumConstantDecl* k : _e.enumerators()) enumerators.push_back(k->getNameAsString());
    JsonObject out{{"enumerators", JsonArray(enumerators)}};
    if (!_g) return out;

    // the numbers of the names of the enumerators. a new enumerator that no scan saw has no number
    std::vector<std::optional<uint32_t>> numbers;
    for (const std::string& k : enumerators) numbers.push_back(_g->names_->find(k));
    struct Found {
      const GraphFunction* fn_ = nullptr;
      const GraphSwitch* s_    = nullptr;
      std::vector<std::string> missing_;
    };  // Found
    std::vector<Found> found;
    const std::optional<uint32_t> name = Detail::index_name_of(*_g, _e);
    if (const auto it = name ? _g->switchesOf_.find(*name) : _g->switchesOf_.end(); it != _g->switchesOf_.end())
      for (const int32_t n : it->second)
        for (const GraphSwitch& s : _g->nodes_[size_t(n)]->switches_) {
          if (s.enum_ != *name) continue;
          Found f{_g->nodes_[size_t(n)], &s, {}};
          for (size_t k = 0; k < enumerators.size(); ++k)
            if (!numbers[k] || !llvm::is_contained(s.handled_, *numbers[k])) f.missing_.push_back(enumerators[k]);
          found.push_back(std::move(f));
        }
    std::ranges::sort(found, [](const Found& _a, const Found& _b) {
      if (_a.missing_.empty() != _b.missing_.empty()) return !_a.missing_.empty();
      if (_a.fn_->file_ != _b.fn_->file_) return _a.fn_->file_ < _b.fn_->file_;
      return _a.s_->line_ < _b.s_->line_;
    });

    JsonArray switches;
    for (size_t i = 0; i < found.size() && i < sites_max_functions; ++i)
      switches.push_back(JsonObject{{"function", found[i].fn_->name_},
                                    {"file", found[i].fn_->file_},
                                    {"line", int64_t(found[i].s_->line_)},
                                    {"missing", JsonArray(found[i].missing_)},
                                    {"hasDefault", found[i].s_->hasDefault_}});
    out["switches"] = std::move(switches);
    if (found.size() > sites_max_functions) out["isCapped"] = true;
    return out;
  }  // enum_sites_to_json

  // the facts of the data members of the records for the heat: the functions that read and write each member, the
  // files of these functions, the first users, and the user on the shortest frame path. with no graph, only the members
  [[nodiscard]] inline JsonObject member_metrics_to_json(const std::vector<const clang::RecordDecl*>& _records,
                                                         const ProjectGraph* _g, const FramePaths* _paths) {
    JsonArray types;
    for (const clang::RecordDecl* rd : _records) {
      const clang::SourceManager& sm = rd->getASTContext().getSourceManager();
      const clang::PrintingPolicy policy(rd->getASTContext().getLangOpts());
      JsonArray members;
      for (const clang::ValueDecl* m : Detail::record_members(*rd, true)) {
        JsonObject o{{"name", m->getNameAsString()},
                     {"line", int64_t(Detail::expansion_line(sm, m->getLocation()))},
                     {"type", m->getType().getAsString(policy)}};
        if (llvm::isa<clang::VarDecl>(m)) o["isStatic"] = true;
        if (_g) {
          // the nodes that use the member. a member that no scan saw has no users
          static const std::vector<int32_t> none;
          const std::vector<int32_t>* nodes  = &none;
          const std::optional<uint32_t> name = Detail::index_name_of(*_g, *m);
          if (const auto it = name ? _g->usersOf_.find(*name) : _g->usersOf_.end(); it != _g->usersOf_.end())
            nodes = &it->second;
          int64_t readers = 0, writers = 0;
          std::unordered_set<int32_t> files;
          JsonArray list;
          const FrameStep* best = nullptr;
          int32_t bestNode      = -1;
          for (const int32_t n : *nodes) {
            const GraphUse* u = Detail::use_of(*_g->nodes_[size_t(n)], *name);
            readers += u && u->isRead_ ? 1 : 0;
            writers += u && u->isWrite_ ? 1 : 0;
            files.insert(_g->fileOf_[size_t(n)]);
            if (list.size() < sites_max_users)
              list.push_back(JsonObject{{"name", _g->nodes_[size_t(n)]->name_},
                                        {"file", _g->nodes_[size_t(n)]->file_},
                                        {"line", int64_t(u ? u->line_ : 0)},
                                        {"isWrite", u && u->isWrite_}});
            if (!_paths) continue;
            if (const auto step = _paths->steps_.find(n);
                step != _paths->steps_.end() && (!best || step->second.depth_ < best->depth_)) {
              best     = &step->second;
              bestNode = n;
            }
          }
          o["readers"] = readers;
          o["writers"] = writers;
          o["files"]   = int64_t(files.size());
          o["users"]   = std::move(list);
          if (best)
            o["frame"] = JsonObject{{"function", _g->nodes_[size_t(bestNode)]->name_},
                                    {"reason", _paths->frames_[size_t(best->frame_)].reason_},
                                    {"calls", int64_t(best->depth_)}};
        }
        members.push_back(std::move(o));
      }
      const clang::SourceRange range = rd->getSourceRange();
      types.push_back(JsonObject{{"name", rd->getNameAsString()},
                                 {"qualifiedName", rd->getQualifiedNameAsString()},
                                 {"kind", Detail::tag_kind(*rd)},
                                 {"line", int64_t(Detail::expansion_line(sm, rd->getLocation()))},
                                 {"first", int64_t(Detail::expansion_line(sm, range.getBegin()))},
                                 {"last", int64_t(Detail::expansion_line(sm, range.getEnd()))},
                                 {"members", std::move(members)}});
    }
    return JsonObject{{"types", std::move(types)}};
  }  // member_metrics_to_json

}  // namespace DataFlow
