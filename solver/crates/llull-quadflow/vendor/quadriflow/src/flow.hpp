#ifndef FLOW_H_
#define FLOW_H_

#include <Eigen/Core>
#include <list>
#include <memory>
#include <map>
#include <vector>

#include "config.hpp"


#include <lemon/network_simplex.h>
#include <lemon/edmonds_karp.h>
#include <lemon/preflow.h>
#include <lemon/smart_graph.h>

using namespace Eigen;

namespace qflow {

class MaxFlowHelper {
   public:
    MaxFlowHelper() {}
    virtual ~MaxFlowHelper(){};
    virtual void resize(int n, int m) = 0;
    virtual void addEdge(int x, int y, int c, int rc, int v, int cost = 1) = 0;
    virtual int compute() = 0;
    virtual void applyTo(std::vector<Vector2i>& edge_diff) = 0;
};

// llull: replaces the upstream Boost Boykov-Kolmogorov helper (Boost is not vendored) by LEMON Edmonds-Karp (an exact, cycle-free maximum flow;
// a push-relabel flow can carry circulations, which the edge-difference update would turn into wrong integer offsets).
class LemonMaxFlowHelper : public MaxFlowHelper {
   public:
    using Graph = lemon::SmartDigraph;
    using Node = Graph::Node;
    template <typename ValueType>
    using ArcMap = lemon::SmartDigraph::ArcMap<ValueType>;
    using MaxFlow = lemon::EdmondsKarp<lemon::SmartDigraph, ArcMap<int>>;

    LemonMaxFlowHelper() : capacity(graph), variable(graph) {}
    void resize(int n, int m) {
        nodes.reserve(n);
        for (int i = 0; i < n; ++i) nodes.push_back(graph.addNode());
    }
    void addEdge(int x, int y, int c, int rc, int v, int cost = 1) {
        if (c) {
            auto e1 = graph.addArc(nodes[x], nodes[y]);
            capacity[e1] = c;
            variable[e1] = std::make_pair(v, -1);
        }
        if (rc) {
            auto e2 = graph.addArc(nodes[y], nodes[x]);
            capacity[e2] = rc;
            variable[e2] = std::make_pair(v, 1);
        }
    }
    int compute() {
        flow = std::make_unique<MaxFlow>(graph, capacity, nodes.front(), nodes.back());
        flow->run();
        return flow->flowValue();
    }
    void applyTo(std::vector<Vector2i>& edge_diff) {
        for (Graph::ArcIt e(graph); e != lemon::INVALID; ++e) {
            int var = variable[e].first;
            if (var == -1) continue;
            edge_diff[var / 2][var % 2] += variable[e].second * flow->flow(e);
        }
    }

   private:
    Graph graph;
    ArcMap<int> capacity;
    ArcMap<std::pair<int, int>> variable;
    std::vector<Node> nodes;
    std::unique_ptr<MaxFlow> flow;
};

class NetworkSimplexFlowHelper : public MaxFlowHelper {
   public:
    using Weight = int;
    using Capacity = int;
    using Graph = lemon::SmartDigraph;
    using Node = Graph::Node;
    using Arc = Graph::Arc;
    template <typename ValueType>
    using ArcMap = lemon::SmartDigraph::ArcMap<ValueType>;
    using Preflow = lemon::Preflow<lemon::SmartDigraph, ArcMap<Capacity>>;
    using NetworkSimplex = lemon::NetworkSimplex<lemon::SmartDigraph, Capacity, Weight>;

   public:
    NetworkSimplexFlowHelper() : cost(graph), capacity(graph), flow(graph), variable(graph) {}
    ~NetworkSimplexFlowHelper(){};
    void resize(int n, int m) {
        nodes.reserve(n);
        for (int i = 0; i < n; ++i) nodes.push_back(graph.addNode());
    }
    void addEdge(int x, int y, int c, int rc, int v, int cst = 1) {
        QFLOW_ASSERT(x >= 0);
        QFLOW_ASSERT(v >= -1);
        if (c) {
            auto e1 = graph.addArc(nodes[x], nodes[y]);
            cost[e1] = cst;
            capacity[e1] = c;
            variable[e1] = std::make_pair(v, 1);
        }

        if (rc) {
            auto e2 = graph.addArc(nodes[y], nodes[x]);
            cost[e2] = cst;
            capacity[e2] = rc;
            variable[e2] = std::make_pair(v, -1);
        }
    }
    int compute() {
        Preflow pf(graph, capacity, nodes.front(), nodes.back());
        NetworkSimplex ns(graph);

        // Run preflow to find maximum flow
        lprintf("push-relabel flow... ");
        pf.runMinCut();
        int maxflow = pf.flowValue();

        // Run network simplex to find minimum cost maximum flow
        ns.costMap(cost).upperMap(capacity).stSupply(nodes.front(), nodes.back(), maxflow);
        auto status = ns.run();
        switch (status) {
            case NetworkSimplex::OPTIMAL:
                ns.flowMap(flow);
                break;
            case NetworkSimplex::INFEASIBLE:
                lputs("NetworkSimplex::INFEASIBLE");
                QFLOW_FAIL("network simplex failed");
                break;
            default:
                lputs("Unknown: NetworkSimplex::Default");
                QFLOW_FAIL("network simplex failed");
                break;
        }

        return maxflow;
    }
    void applyTo(std::vector<Vector2i>& edge_diff) {
        for (Graph::ArcIt e(graph); e != lemon::INVALID; ++e) {
            int var = variable[e].first;
            if (var == -1) continue;
            int sgn = variable[e].second;
            edge_diff[var / 2][var % 2] -= sgn * flow[e];
        }
    }

   private:
    Graph graph;
    ArcMap<Weight> cost;
    ArcMap<Capacity> capacity;
    ArcMap<Capacity> flow;
    ArcMap<std::pair<int, int>> variable;
    std::vector<Node> nodes;
    std::vector<Arc> edges;
};

class ECMaxFlowHelper : public MaxFlowHelper {
   public:
    struct FlowInfo {
        int id;
        int capacity, flow;
        int v, d;
        FlowInfo* rev;
    };
    struct SearchInfo {
        SearchInfo(int _id, int _prev_id, FlowInfo* _info)
            : id(_id), prev_id(_prev_id), info(_info) {}
        int id;
        int prev_id;
        FlowInfo* info;
    };
    ECMaxFlowHelper() { num = 0; }
    int num;
    std::vector<FlowInfo*> variable_to_edge;
    void resize(int n, int m) {
        graph.resize(n);
        variable_to_edge.resize(m, 0);
        num = n;
    }
    void addEdge(int x, int y, int c, int rc, int v, int cost = 0) {
        FlowInfo flow;
        flow.id = y;
        flow.capacity = c;
        flow.flow = 0;
        flow.v = v;
        flow.d = -1;
        graph[x].push_back(flow);
        auto& f1 = graph[x].back();
        flow.id = x;
        flow.capacity = rc;
        flow.flow = 0;
        flow.v = v;
        flow.d = 1;
        graph[y].push_back(flow);
        auto& f2 = graph[y].back();
        f2.rev = &f1;
        f1.rev = &f2;
    }
    int compute() {
        int total_flow = 0;
        int count = 0;
        while (true) {
            count += 1;
            std::vector<int> vhash(num, 0);
            std::vector<SearchInfo> q;
            q.push_back(SearchInfo(0, -1, 0));
            vhash[0] = 1;
            int q_front = 0;
            bool found = false;
            while (q_front < q.size()) {
                int vert = q[q_front].id;
                for (auto& l : graph[vert]) {
                    if (vhash[l.id] || l.capacity <= l.flow) continue;
                    q.push_back(SearchInfo(l.id, q_front, &l));
                    vhash[l.id] = 1;
                    if (l.id == num - 1) {
                        found = true;
                        break;
                    }
                }
                if (found) break;
                q_front += 1;
            }
            if (q_front == q.size()) break;
            int loc = q.size() - 1;
            while (q[loc].prev_id != -1) {
                q[loc].info->flow += 1;
                q[loc].info->rev->flow -= 1;
                loc = q[loc].prev_id;
                // int prev_v = q[loc].id;
                // applyFlow(prev_v, current_v, 1);
                // applyFlow(current_v, prev_v, -1);
            }
            total_flow += 1;
        }
        return total_flow;
    }
    void applyTo(std::vector<Vector2i>& edge_diff) {
        for (int i = 0; i < graph.size(); ++i) {
            for (auto& flow : graph[i]) {
                if (flow.flow > 0 && flow.v != -1) {
                    if (flow.flow > 0) {
                        edge_diff[flow.v / 2][flow.v % 2] += flow.d * flow.flow;
                        if (abs(edge_diff[flow.v / 2][flow.v % 2]) > 2) {
                        }
                    }
                }
            }
        }
    }
    void applyFlow(int v1, int v2, int flow) {
        for (auto& it : graph[v1]) {
            if (it.id == v2) {
                it.flow += flow;
                break;
            }
        }
    }
    std::vector<std::list<FlowInfo>> graph;
};

} // namespace qflow

#endif
